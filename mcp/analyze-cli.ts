#!/usr/bin/env node
/**
 * pi-lens-analyze — standalone per-file analysis for the *push* half of the
 * mirror: a Claude Code PostToolUse hook (matched to Edit|Write) that fires
 * pi-lens automatically after every edit, the way pi's per-edit pipeline does.
 * Also usable as a plain CLI for testing/debugging.
 *
 * Reuses the Tier 1 `analyzeFile` facade. Defaults to `no-lsp` so inline
 * feedback is FAST (cold LSP would cost ~5s per edit and under-report anyway —
 * pull `pilens_analyze` against the warm MCP server for the type-check). The
 * fast runners (tree-sitter structural, ast-grep security, biome/ruff/oxlint
 * lint, complexity) are complete even in a cold process.
 *
 * Input: `--file=<path>` (+ optional `--cwd=`), or — when no `--file` and stdin
 * is piped — a Claude Code PostToolUse JSON payload on stdin (`tool_input.path`/
 * `file_path` + `cwd`). Output: a concise report on stdout; with `--hook`, a
 * PostToolUse JSON envelope that injects the report as context. Exit 0 always
 * (advisory — never blocks the edit).
 */

import * as path from "node:path";
import type { McpAnalyzeResult } from "../clients/mcp/analyze.js";
import { requestWarmAnalyze } from "../clients/mcp/ipc.js";

console.log = (...args: unknown[]) => console.error(...args);

function argVal(name: string): string | undefined {
	const prefix = `--${name}=`;
	const found = process.argv.find((value) => value.startsWith(prefix));
	return found ? found.slice(prefix.length) : undefined;
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

function formatReport(result: McpAnalyzeResult, cwd: string): string {
	const rel = path.relative(cwd, result.filePath) || result.filePath;
	const lines = [
		`🔎 pi-lens: ${rel} — ${result.counts.blockers} blocking, ${result.counts.warnings} warning(s)`,
	];
	for (const d of result.diagnostics.slice(0, 30)) {
		const marker = d.semantic === "blocking" ? "🔴" : "⚠";
		const label = d.rule ?? d.tool;
		lines.push(`  ${marker} L${d.line ?? "?"} ${label}: ${d.message}`);
	}
	if (result.diagnostics.length > 30) {
		lines.push(`  … ${result.diagnostics.length - 30} more`);
	}
	if (result.lsp && result.lsp.status === "skipped") {
		lines.push(
			"  (LSP type-check skipped — run pilens_analyze on the warm MCP server for type errors)",
		);
	}
	return lines.join("\n");
}

async function resolveTarget(): Promise<{ file?: string; cwd: string }> {
	let file = argVal("file");
	let cwd = argVal("cwd") ?? process.cwd();
	if (!file && !process.stdin.isTTY) {
		try {
			const data = JSON.parse(await readStdin()) as {
				cwd?: string;
				tool_input?: { file_path?: string; path?: string };
			};
			file = data.tool_input?.file_path ?? data.tool_input?.path;
			cwd = data.cwd ?? cwd;
		} catch {
			// not a JSON payload — nothing to analyze
		}
	}
	return { file, cwd };
}

async function main(): Promise<void> {
	const hookMode = process.argv.includes("--hook");
	const withLsp = process.argv.includes("--lsp");
	const { file, cwd } = await resolveTarget();
	if (!file) process.exit(0); // nothing to analyze — stay silent

	// Warm path first: if the MCP server is up for this workspace, it analyzes in
	// its warm process (LSP-COMPLETE) and we never load the dispatch graph here.
	// Falls back to a cold, no-LSP local run when no server is reachable.
	let result = await requestWarmAnalyze(cwd, file);
	if (!result) {
		const { analyzeFile } = await import("../clients/mcp/analyze.js");
		result = await analyzeFile(file, cwd, {
			flags: withLsp ? {} : { "no-lsp": true },
			record: false,
			// Edit-detection path (PostToolUse) — mark the file for pilens_turn_end.
			registerTurnState: true,
		});
	}

	if (result.counts.diagnostics === 0) process.exit(0); // clean → no noise

	const report = formatReport(result, cwd);
	if (hookMode) {
		process.stdout.write(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PostToolUse",
					additionalContext: report,
				},
			}),
		);
	} else {
		process.stdout.write(`${report}\n`);
	}
	process.exit(0);
}

main().catch((err) => {
	process.stderr.write(`pi-lens-analyze failed: ${(err as Error).message}\n`);
	process.exit(0); // advisory — never break the edit flow
});
