#!/usr/bin/env node
/**
 * pi-lens MCP `fresh`-mode worker.
 *
 * The review-loop honesty guarantee: the MCP server is long-lived, so after a
 * commit + rebuild it still holds the OLD code in memory. This worker is a
 * short-lived child the server forks per `fresh` analysis — a brand-new `node`
 * process loads the *freshly built* `analyze.js` (and its dispatch graph) from
 * disk, so the measurement reflects the latest commit, not the server's stale
 * image. stdout carries exactly one JSON `McpAnalyzeResult`; diagnostics go to
 * stderr.
 */

import { setProjectTrustState } from "../clients/project-trust.js";
import { logExtension } from "../clients/extension-log.js";
import { analyzeFile } from "../clients/mcp/analyze.js";
import { initLSPConfig } from "../clients/lsp/config.js";

function arg(name: string): string | undefined {
	const prefix = `--${name}=`;
	const found = process.argv.find((value) => value.startsWith(prefix));
	return found ? found.slice(prefix.length) : undefined;
}

async function main(): Promise<void> {
	// #4300: this process runs outside pi; its caller owns workspace trust.
	setProjectTrustState("trusted");
	logExtension({
		subsystem: "project-trust",
		level: "debug",
		message:
			"mcp-worker: workspace trust belongs to the MCP client; pi trust not consulted",
	});

	const file = arg("file");
	const cwd = arg("cwd") ?? process.cwd();
	if (!file) {
		process.stderr.write("worker: --file is required\n");
		process.exit(2);
	}

	let flags: Record<string, boolean | string | undefined> | undefined;
	const flagsRaw = arg("flags");
	if (flagsRaw) {
		try {
			flags = JSON.parse(flagsRaw) as Record<
				string,
				boolean | string | undefined
			>;
		} catch {
			process.stderr.write("worker: --flags must be valid JSON\n");
			process.exit(2);
		}
	}

	// #5699: the user's LSP config (`serverOverrides`, `disabledServers`), as
	// the host loads it in `ensureReady`. Without it the worker ran the
	// built-in servers, so a fresh analysis measured other servers than the
	// warm one. A failed load keeps the defaults, as the host's does.
	try {
		await initLSPConfig(cwd);
		// pi-lens-ignore: missing-error-propagation
	} catch (err) {
		process.stderr.write(`worker: initLSPConfig failed for ${cwd}: ${err}\n`);
	}

	const result = await analyzeFile(file, cwd, { flags });
	// Flush before exiting — a bare process.exit can truncate a piped write. The
	// explicit exit is needed because spawned LSP/runner handles would otherwise
	// keep the event loop alive.
	process.stdout.write(JSON.stringify(result), () => process.exit(0));
}

main().catch((err) => {
	process.stderr.write(`worker failed: ${(err as Error).message}\n`);
	process.exit(1);
});
