// mutation-lane: exclude
// flake-shape: raw-timer-wait — the spawned MCP child re-stats the real stamp file; a fixed settle clears the filesystem mtime a fake clock cannot advance
/**
 * #5159 — a stale warm-build advisory must not break a JSON cell.
 *
 * Spawns the real MCP server (`mcp/server.js`, needs `npm run build`), arms the
 * warm-build staleness gate through the isolated stamp file, and drives the
 * spawned-server scenarios from the R1 review matrix: a stale `full-json` cell
 * stays parseable in `content[0]`, the advisory rides a trailing block, the
 * delivered text stays inside MAX_RESULT_BYTES with no envelope allowance, an
 * ignored-argument note also rides an annotation block, a truncated cell keeps
 * the advisory and reports `truncated=true`, an `lsp_navigation` envelope parses
 * in block 0 with the advisory trailing it, and a fresh control parses too.
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	MAX_RESULT_BYTES,
	stripContractFooter,
} from "../../tools/render-compact.js";
import { McpHarness } from "./harness.js";

type ToolResult = {
	content?: { type: string; text?: string }[];
	isError?: boolean;
};

const ADVISORY_PREFIX = "warmCodeStale: true";

function blockTexts(result: ToolResult): string[] {
	return (result.content ?? [])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string);
}

function writeWorkspace(prefix: string): string {
	const workspace = mkdtempSync(path.join(tmpdir(), prefix));
	writeFileSync(
		path.join(workspace, "small.ts"),
		"export function alpha(): number {\n\treturn 1;\n}\n",
	);
	const lines = ["// Oversized fixture: must exceed MAX_RESULT_BYTES."];
	for (let i = 0; i < 1200; i++) {
		lines.push(`export function sym${i}(): number {\n\treturn ${i};\n}`);
	}
	writeFileSync(path.join(workspace, "big-source.ts"), `${lines.join("\n")}\n`);
	return workspace;
}

describe("stale JSON-cell advisory (#5159, real spawn)", { retry: 2 }, () => {
	let freshHarness: McpHarness;
	let staleHarness: McpHarness;
	let stampDir: string;
	let stampFile: string;
	let freshWorkspace: string;
	let staleWorkspace: string;

	beforeAll(() => {
		stampDir = mkdtempSync(path.join(tmpdir(), "pi-lens-5159-stamp-"));
		stampFile = path.join(stampDir, "entry-stamp.txt");
		writeFileSync(stampFile, "initial\n");
		freshWorkspace = writeWorkspace("pi-lens-5159-fresh-ws-");
		staleWorkspace = writeWorkspace("pi-lens-5159-stale-ws-");
		freshHarness = new McpHarness({ cwd: freshWorkspace });
		staleHarness = new McpHarness({
			cwd: staleWorkspace,
			env: {
				PI_LENS_MCP_STALENESS_STAT_PATH: stampFile,
				PI_LENS_MCP_STALENESS_INTERVAL_MS: "0",
				PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS: "20000",
				PI_LENS_AUX_GRACE_MS: "20000",
			},
		});
	});

	afterAll(() => {
		freshHarness?.dispose();
		staleHarness?.dispose();
		rmSync(stampDir, { recursive: true, force: true });
	});

	async function initialize(harness: McpHarness, id: number, tag: string) {
		await harness.request(id, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: tag, version: "0" },
		});
		harness.notify("notifications/initialized");
	}

	async function callModuleReport(
		harness: McpHarness,
		id: number,
		args: Record<string, unknown>,
	): Promise<ToolResult> {
		const res = await harness.request(id, "tools/call", {
			name: "pilens_module_report",
			arguments: args,
		});
		return res.result as ToolResult;
	}

	async function armStale(): Promise<void> {
		const future = new Date(Date.now() + 5 * 60_000);
		utimesSync(stampFile, future, future);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	it("fresh control: a full-json cell parses after the owner footer strip", async () => {
		await initialize(freshHarness, 1, "fresh-control");
		const result = await callModuleReport(freshHarness, 2, {
			file: path.join(freshWorkspace, "small.ts"),
			view: "full-json",
		});
		expect(result.isError).toBeFalsy();
		const blocks = blockTexts(result);
		expect(blocks).toHaveLength(1);
		expect(() => JSON.parse(stripContractFooter(blocks[0]))).not.toThrow();
	}, 60_000);

	it("stale: payload block parses, advisory rides a trailing block, and the delivered text is bounded without the envelope allowance", async () => {
		await initialize(staleHarness, 10, "stale-cell");
		await armStale();
		const result = await callModuleReport(staleHarness, 11, {
			file: path.join(staleWorkspace, "small.ts"),
			view: "full-json",
		});
		expect(result.isError).toBeFalsy();
		const blocks = blockTexts(result);
		expect(blocks).toHaveLength(2);
		expect(() => JSON.parse(stripContractFooter(blocks[0]))).not.toThrow();
		expect(blocks[1].startsWith(ADVISORY_PREFIX)).toBe(true);
		// Fresh control: the fresh cell is the payload alone plus the footer in one
		// block; stripping the footer must give back the stale payload block
		// byte-for-byte. The advisory is the only difference.
		const freshResult = await callModuleReport(freshHarness, 12, {
			file: path.join(freshWorkspace, "small.ts"),
			view: "full-json",
		});
		expect(freshResult.isError).toBeFalsy();
		const freshBlocks = blockTexts(freshResult);
		expect(freshBlocks).toHaveLength(1);
		expect(stripContractFooter(freshBlocks[0])).toBe(blocks[0]);
		const delivered = blocks.join("\n");
		expect(Buffer.byteLength(delivered, "utf8")).toBeLessThanOrEqual(
			MAX_RESULT_BYTES,
		);
		const footerBytes = Number(delivered.match(/bytes=(\d+)/)?.[1]);
		expect(Number.isFinite(footerBytes)).toBe(true);
		expect(footerBytes).toBeLessThanOrEqual(MAX_RESULT_BYTES);
	}, 60_000);

	it("stale: an ignored-argument note rides its own block ahead of the advisory and the payload still parses", async () => {
		await initialize(staleHarness, 20, "stale-ignored");
		await armStale();
		const result = await callModuleReport(staleHarness, 21, {
			file: path.join(staleWorkspace, "small.ts"),
			view: "full-json",
			bogusArgument: 1,
		});
		const blocks = blockTexts(result);
		// Wire order: payload, ignored-arguments annotation, stale advisory.
		expect(blocks).toHaveLength(3);
		expect(() => JSON.parse(stripContractFooter(blocks[0]))).not.toThrow();
		expect(
			blocks[1].startsWith(
				"Ignored unknown argument(s) for pilens_module_report",
			),
		).toBe(true);
		expect(blocks[2].startsWith(ADVISORY_PREFIX)).toBe(true);
	}, 60_000);

	it("stale: an oversized full-json cell truncates, keeps the advisory, and stays inside MAX_RESULT_BYTES", async () => {
		await initialize(staleHarness, 30, "stale-truncated");
		await armStale();
		const result = await callModuleReport(staleHarness, 31, {
			file: path.join(staleWorkspace, "big-source.ts"),
			view: "full-json",
		});
		expect(result.isError).toBeFalsy();
		const blocks = blockTexts(result);
		expect(blocks).toHaveLength(2);
		expect(() => JSON.parse(stripContractFooter(blocks[0]))).toThrow();
		expect(blocks[1].startsWith(ADVISORY_PREFIX)).toBe(true);
		const delivered = blocks.join("\n");
		expect(delivered).toMatch(/truncated=true$/);
		expect(Buffer.byteLength(delivered, "utf8")).toBeLessThanOrEqual(
			MAX_RESULT_BYTES,
		);
	}, 60_000);

	it("stale: an lsp_navigation envelope parses in block 0 and the advisory rides a trailing block", async (ctx) => {
		await initialize(staleHarness, 40, "stale-lsp-nav");
		await armStale();
		const res = await staleHarness.request(41, "tools/call", {
			name: "pilens_lsp_navigation",
			arguments: {
				operation: "documentSymbol",
				path: path.join(staleWorkspace, "small.ts"),
			},
		});
		const result = res.result as ToolResult;
		if (result.isError) {
			// #5159 D6: the parse invariant covers non-error cells only. This lane
			// refuses tool installs, so the tool answers an error envelope and
			// `withStaleWarning` skips error cells, so no advisory is delivered.
			// Pin that shape, then skip visibly: the advisory-placement checks
			// below did not run here; the live envelope is covered by
			// lsp-spawn-heavy.
			const errorBlocks = blockTexts(result);
			expect(errorBlocks).toHaveLength(1);
			expect(errorBlocks[0]).toMatch(/\n\nresult error\n/);
			expect(errorBlocks[0]).not.toContain(ADVISORY_PREFIX);
			return ctx.skip(
				"lsp_navigation answered an error envelope (tool installs refused); advisory placement is covered by lsp-spawn-heavy",
			);
		}
		const blocks = blockTexts(result);
		expect(blocks).toHaveLength(2);
		// The envelope flows through the tool's real `finalize` and the wire. This
		// lane refuses tool installs (`PI_LENS_DISABLE_TOOL_INSTALL=1`), so the
		// answer degrades to `status: "empty"`, `resultCount: 0`; the live-symbol
		// assertion belongs to the `lsp-spawn-heavy` lane. The block contract is
		// the same in both.
		const envelope = JSON.parse(stripContractFooter(blocks[0])) as {
			ok?: boolean;
			status?: string;
			resultCount?: number;
		};
		expect(typeof envelope.ok).toBe("boolean");
		expect(typeof envelope.status).toBe("string");
		expect(typeof envelope.resultCount).toBe("number");
		expect(blocks[1].startsWith(ADVISORY_PREFIX)).toBe(true);
	}, 90_000);
});
