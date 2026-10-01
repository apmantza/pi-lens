// mutation-lane: exclude
/**
 * #3791: a warm MCP `pilens_analyze` pull must report the coverage notice on
 * EVERY call, not only the first.
 *
 * The dispatcher dedupes the synthetic coverage notice once per session
 * (`coverageNoticeSeen`, clients/dispatch/dispatcher.ts). That latch suits the
 * pi push surface — a per-edit notice should not repeat on every keystroke —
 * but `pilens_analyze` is a pull surface: each call is a deliberate question,
 * and a later pull of a file pi-lens never analysed must not read as a clean
 * result (the #3750/#3749 false-clean class).
 *
 * The unanalysable input is deterministic: a Go file analysed with `no-lsp` by
 * a server whose PATH holds no `go`/`gopls`/`golangci-lint`, so every primary
 * and fallback linter skips and only structural runners run. PATH is handed to
 * the server subprocess (the harness merges it over `process.env`), so the
 * case does not depend on what the host happens to have installed.
 *
 * Requires `npm run build` first (resolves mcp/server.js next to its source).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpHarness } from "./harness.js";

interface AnalyzeShape {
	counts: {
		diagnostics: number;
		warnings: number;
		advisories: number;
		blockers: number;
		fixed: number;
	};
	diagnostics: Array<{ message: string }>;
}

function parseAnalyze(res: Record<string, unknown>): AnalyzeShape {
	const text = (res.result as { content: { text: string }[] }).content[0].text;
	return JSON.parse(
		text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
	) as AnalyzeShape;
}

describe("pilens_analyze coverage notice across repeat warm pulls (#3791)", () => {
	let projectDir: string;
	let harness: McpHarness;

	beforeAll(async () => {
		projectDir = mkdtempSync(path.join(tmpdir(), "pi-lens-analyze-coverage-"));
		writeFileSync(
			path.join(projectDir, "main.go"),
			"package main\n\nfunc main() {}\n",
		);
		harness = new McpHarness({ cwd: projectDir, env: { PATH: "" } });
		const init = await harness.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "analyze-coverage-smoke", version: "0" },
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

	it("carries a coverage warning on the first, second, and third pull", async () => {
		const analyze = (id: number) =>
			harness.request(id, "tools/call", {
				name: "pilens_analyze",
				arguments: {
					file: path.join(projectDir, "main.go"),
					cwd: projectDir,
					flags: { "no-lsp": true },
				},
			});

		const first = parseAnalyze(await analyze(10));
		const second = parseAnalyze(await analyze(11));
		const third = parseAnalyze(await analyze(12));

		for (const [label, result] of [
			["first", first],
			["second", second],
			["third", third],
		] as const) {
			expect(
				result.counts.warnings,
				`${label} pull must carry the coverage warning`,
			).toBeGreaterThanOrEqual(1);
		}
	}, 60_000);
});
