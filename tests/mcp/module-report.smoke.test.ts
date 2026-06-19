/**
 * module_report / read_symbol MCP smoke (#245, #256).
 *
 * Drives the real stdio JSON-RPC transport against a tiny synthetic TS project so
 * the review-graph build is instant (targeting the whole repo would cold-build the
 * graph and block the server). Two layers:
 *   - basic: module_report + read_symbol answer over the transport (LSP off).
 *   - live-LSP (gated on a real typescript server): the on-demand, file-scoped
 *     enrichment tier (clients/module-report-lsp.ts) adds live references with
 *     `live-lsp` provenance — fired up only for the requested file.
 *
 * Requires `npm run build` first (resolves mcp/server.js next to its source).
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpHarness, repoRoot } from "./harness.js";

const TS_LSP = ["typescript-language-server", "typescript-language-server.cmd"].some(
	(bin) => existsSync(path.join(repoRoot, "node_modules", ".bin", bin)),
);

interface ModuleReportShape {
	available: boolean;
	semantic: { source: string; references: boolean; implementations: boolean };
	api: Array<{
		name: string;
		usedBy?: Array<{ file: string; provenance?: string }>;
	}>;
}

function textOf(res: Record<string, unknown>): string {
	return (res.result as { content: { text: string }[] }).content[0].text;
}

function parseReport(res: Record<string, unknown>): ModuleReportShape {
	const text = textOf(res);
	// The tool wraps the JSON body in a header + fenced block; slice to the object.
	return JSON.parse(
		text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
	) as ModuleReportShape;
}

/** Tiny TS project: `foo` is defined and used (same-file) by `useFoo`. */
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

function cleanupDir(dir: string): void {
	// tsserver child handles can briefly linger on Windows (EPERM) — best effort.
	try {
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	} catch {
		// OS reclaims the temp dir eventually; not worth failing the run over.
	}
}

async function initialize(harness: McpHarness, name: string): Promise<void> {
	const init = await harness.request(1, "initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name, version: "0" },
	});
	expect((init.result as { protocolVersion: string }).protocolVersion).toBe(
		"2025-06-18",
	);
	harness.notify("notifications/initialized");
}

describe("module_report + read_symbol over MCP (tiny project)", () => {
	let projectDir: string;
	let harness: McpHarness;

	beforeAll(async () => {
		projectDir = makeTinyProject("pi-lens-modreport-mcp-");
		harness = new McpHarness({ cwd: projectDir }); // LSP tier default-off
		await initialize(harness, "modreport-smoke");
	});

	afterAll(() => {
		harness.dispose();
		cleanupDir(projectDir);
	});

	it("answers pilens_module_report with a navigable report", async () => {
		const res = await harness.request(10, "tools/call", {
			name: "pilens_module_report",
			arguments: { file: path.join(projectDir, "a.ts") },
		});
		const report = parseReport(res);
		expect(report.available).toBe(true);
		expect(report.api.some((e) => e.name === "foo")).toBe(true);
		// LSP tier off → no live enrichment claimed.
		expect(report.semantic.source).toBe("none");
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
});

describe.skipIf(!TS_LSP)("module_report live-LSP enrichment (on-demand)", () => {
	let projectDir: string;
	let harness: McpHarness;

	beforeAll(async () => {
		projectDir = makeTinyProject("pi-lens-live-lsp-");
		harness = new McpHarness({
			cwd: projectDir,
			env: {
				PI_LENS_MODULE_REPORT_LSP_BUDGET_MS: "10000",
				// Let references() wait for the cold tsserver to come up within a single
				// call, so the on-demand spawn resolves inside the budget.
				PI_LENS_LSP_NAV_CLIENT_WAIT_MS: "8000",
			},
			defaultTimeoutMs: 90_000,
		});
		await initialize(harness, "live-lsp-smoke");
	});

	afterAll(() => {
		harness.dispose();
		cleanupDir(projectDir);
	});

	it("fires up the LSP for the requested file alone and enriches it", async () => {
		// Spawn + index tsserver for a.ts (mirrors a real session where pi keeps the
		// edited file's server warm), then let module_report's own references run.
		await harness.request(2, "tools/call", {
			name: "pilens_lsp_navigation",
			arguments: {
				operation: "documentSymbol",
				filePath: path.join(projectDir, "a.ts"),
			},
		});

		// Poll a few times — a freshly-spawned server can lag the first request.
		const target = path.join(projectDir, "a.ts");
		let report: ModuleReportShape | undefined;
		for (let attempt = 0; attempt < 5; attempt++) {
			const res = await harness.request(10 + attempt, "tools/call", {
				name: "pilens_module_report",
				arguments: { file: target },
			});
			report = parseReport(res);
			if (report.semantic.source === "live-lsp") break;
		}

		expect(report).toBeDefined();
		// Live LSP was consulted on demand, not just the AST graph.
		expect(report!.semantic.source).toBe("live-lsp");
		expect(report!.semantic.references).toBe(true);

		// `foo`'s who-uses-this carries LSP provenance (the useFoo call sites).
		const foo = report!.api.find((e) => e.name === "foo");
		expect(foo).toBeDefined();
		const lspRefs = foo!.usedBy?.filter((u) => u.provenance === "lsp") ?? [];
		expect(lspRefs.length).toBeGreaterThan(0);
		expect(lspRefs.some((u) => u.file.endsWith("a.ts"))).toBe(true);
	}, 180_000);
});
