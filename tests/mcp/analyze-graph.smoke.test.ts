// mutation-lane: exclude
/**
 * Warm `pilens_analyze` review-graph maintenance (#536, item 1).
 *
 * Drives the real stdio JSON-RPC transport against a tiny two-file TS fixture
 * where b.ts imports a.ts. Before any `pilens_analyze` call, `pilens_module_report`
 * on a.ts must show no who-uses-this data (cold graph — #536 retires the #256
 * "read-only facade" contract for warm mode specifically, so a fresh server has
 * no graph yet). After warm-analyzing b.ts (the importer), the review graph must
 * have gained b.ts's import edge, so a subsequent `pilens_module_report` on a.ts
 * reports `usedBy`/`semantic.source: "review-graph"` for it — proof the graph was
 * actually built/updated as a side effect of `pilens_analyze`, not just read.
 *
 * Requires `npm run build` first (resolves mcp/server.js next to its source).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildWordIndex,
	serializeWordIndex,
} from "../../clients/word-index.js";
import {
	flushProjectSnapshotPersistsForTests,
	PROJECT_SNAPSHOT_VERSION,
	saveProjectSnapshot,
} from "../../clients/project-snapshot.js";
import { McpHarness } from "./harness.js";

interface ModuleReportShape {
	available: boolean;
	semantic: { source: string; references: boolean; implementations: boolean };
	api: Array<{
		name: string;
		usedBy?: Array<{ file: string; symbol: string }>;
	}>;
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

function makeTwoFileProject(prefix: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	writeFileSync(
		path.join(dir, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { strict: true } }, null, 2),
	);
	writeFileSync(
		path.join(dir, "a.ts"),
		["export function foo(): number {", "  return 1;", "}", ""].join("\n"),
	);
	writeFileSync(
		path.join(dir, "b.ts"),
		[
			'import { foo } from "./a.js";',
			"",
			"export function useFoo(): number {",
			"  return foo() + foo();",
			"}",
			"",
		].join("\n"),
	);
	return dir;
}

describe("pilens_analyze (warm) maintains the review graph over MCP", () => {
	let projectDir: string;
	let harness: McpHarness;

	beforeAll(async () => {
		projectDir = makeTwoFileProject("pi-lens-analyze-graph-mcp-");
		harness = new McpHarness({ cwd: projectDir });
		const init = await harness.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "analyze-graph-smoke", version: "0" },
		});
		expect((init.result as { protocolVersion: string }).protocolVersion).toBe(
			"2025-06-18",
		);
		harness.notify("notifications/initialized");
		// Pay the one-time server startup cost before the asserted request window.
		await harness.request(2, "tools/call", {
			name: "pilens_health",
			arguments: {},
		});
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

	it("has no who-uses-this data for a.ts before analyze, then gains usedBy(b.ts) after warm-analyzing the importer", async () => {
		// Cold first, inside this one case: a sibling case that analyzes would warm
		// the shared server, and shuffle runs cases in any order (#4561 census row).
		const res = await harness.request(10, "tools/call", {
			name: "pilens_module_report",
			arguments: { file: path.join(projectDir, "a.ts") },
		});
		const coldReport = parseReport(res);
		expect(coldReport.available).toBe(true);
		expect(coldReport.semantic.source).toBe("none");
		const analyzeRes = await harness.request(11, "tools/call", {
			name: "pilens_analyze",
			arguments: {
				file: path.join(projectDir, "b.ts"),
				cwd: projectDir,
				flags: { "no-lsp": true },
			},
		});
		expect((analyzeRes.result as { isError?: boolean }).isError).toBeFalsy();

		const reportRes = await harness.request(12, "tools/call", {
			name: "pilens_module_report",
			arguments: { file: path.join(projectDir, "a.ts") },
		});
		const report = parseReport(reportRes);
		expect(report.available).toBe(true);
		// The graph now has a node for a.ts (built as a side effect of analyzing
		// b.ts, which imports it) — semantic.source flips from "none" to
		// "review-graph", proof pilens_analyze maintained the graph, not just read it.
		expect(report.semantic.source).toBe("review-graph");
		const foo = report.api.find((entry) => entry.name === "foo");
		expect(
			foo?.usedBy?.some((u) => u.file.replace(/\\/g, "/").endsWith("b.ts")),
		).toBe(true);
	}, 30_000);
});

// #536 rider (issue body: "when #348 phase 2 lands, the word-index per-edit
// update should ride the SAME seam so both indexes stay warm together") —
// separate project/harness so this suite's pre-seeded word-index snapshot
// (with a #348-phase-2 forward index) doesn't interact with the graph suite
// above.
describe("pilens_analyze (warm) also maintains the word index over MCP (#536 rider)", () => {
	let projectDir: string;
	let snapshotDataRoot: string;
	let harness: McpHarness;

	// The table's rows, in rank order. `symbol_search` renders one row per hit
	// (`  1. <path> <line> (score 0.82, 3 hit(s))`); it carries no JSON payload
	// (#5104), so the row line IS the result.
	function tableRows(
		res: Record<string, unknown>,
	): Array<{ file: string; line: number }> {
		return textOf(res)
			.split("\n")
			.flatMap((line) => {
				const match = /^\s+\d+\.\s+(.+?)\s+(\d+)\s+\(score .*\)$/.exec(line);
				return match
					? [{ file: match[1].replace(/\\/g, "/"), line: Number(match[2]) }]
					: [];
			});
	}

	function namesWidgetTs(res: Record<string, unknown>): boolean {
		return tableRows(res).some((row) => row.file.endsWith("widget.ts"));
	}

	beforeAll(async () => {
		projectDir = mkdtempSync(
			path.join(tmpdir(), "pi-lens-analyze-wordindex-mcp-"),
		);
		writeFileSync(
			path.join(projectDir, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true } }, null, 2),
		);
		writeFileSync(
			path.join(projectDir, "base.ts"),
			"export function baseFn(): number {\n  return 1;\n}\n",
		);
		// Pre-seed a snapshot with a #348-phase-2 forward index (buildWordIndex
		// always populates `forward`) covering only base.ts — the new identifier
		// this test introduces (widgetRenderer) must NOT be in it yet, so a hit on
		// it can only come from the per-edit update, never the pre-seeded snapshot.
		const index = buildWordIndex([
			{
				path: path.join(projectDir, "base.ts"),
				content: "export function baseFn(): number {\n  return 1;\n}\n",
			},
		]);
		snapshotDataRoot = mkdtempSync(
			path.join(tmpdir(), "pi-lens-analyze-wordindex-data-"),
		);
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = snapshotDataRoot;
		try {
			saveProjectSnapshot(projectDir, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: projectDir,
				generatedAt: new Date().toISOString(),
				seq: 0,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [],
				wordIndex: serializeWordIndex(index),
			});
			// The production snapshot body is worker-persisted. Flush the test seed
			// before spawning a separate MCP process; otherwise a loaded CI worker can
			// race the child and make a valid pre-seeded index look unavailable.
			flushProjectSnapshotPersistsForTests();
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
		}

		harness = new McpHarness({
			cwd: projectDir,
			env: { PILENS_DATA_DIR: snapshotDataRoot },
		});
		const init = await harness.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "analyze-wordindex-smoke", version: "0" },
		});
		expect((init.result as { protocolVersion: string }).protocolVersion).toBe(
			"2025-06-18",
		);
		harness.notify("notifications/initialized");
		// Pay the one-time server startup cost before the asserted request window.
		await harness.request(2, "tools/call", {
			name: "pilens_health",
			arguments: {},
		});
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
			rmSync(snapshotDataRoot, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 200,
			});
		} catch {
			// OS reclaims the temp dir eventually.
		}
	});

	it("ranks a newly-analyzed file's new identifier via symbol_search, same process, no rebuild", async () => {
		// Baseline: the new identifier doesn't exist in the pre-seeded snapshot.
		const before = await harness.request(20, "tools/call", {
			name: "pilens_symbol_search",
			arguments: { query: "widget renderer", cwd: projectDir },
		});
		expect(namesWidgetTs(before)).toBe(false);

		const newFile = path.join(projectDir, "widget.ts");
		writeFileSync(
			newFile,
			"export function widgetRenderer(): number {\n  return 2;\n}\n",
		);

		const analyzeRes = await harness.request(21, "tools/call", {
			name: "pilens_analyze",
			arguments: { file: newFile, cwd: projectDir, flags: { "no-lsp": true } },
		});
		expect((analyzeRes.result as { isError?: boolean }).isError).toBeFalsy();

		// No pilens_rebuild / pilens_session_start call in between — the ranked
		// hit must come from the SAME process's warm in-memory index, updated
		// in place by the analyze call above, not a fresh full rebuild.
		const after = await harness.request(22, "tools/call", {
			name: "pilens_symbol_search",
			arguments: { query: "widget renderer", cwd: projectDir },
		});
		// Rank 1: the row names the new file at the identifier's line, which no
		// pre-seeded snapshot entry can supply.
		expect(tableRows(after)[0]).toEqual({ file: "widget.ts", line: 1 });
	}, 30_000);
});
