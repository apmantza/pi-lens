/**
 * Warm side-channel for the push path. The MCP server is a long-lived process
 * with a warm LSP, but its stdio is owned by the MCP client — so the
 * PostToolUse-hook bin can't reach it that way. Instead the server listens on a
 * local IPC endpoint (Unix domain socket / Windows named pipe), and the hook
 * connects to it to get LSP-complete diagnostics from the warm process instead
 * of running its own cold analysis.
 *
 * This module is the CLIENT + the shared path derivation only — deliberately
 * light (node:net + type-only result), so the bin can try the warm path WITHOUT
 * loading the dispatch graph. The server side lives in mcp/server.ts (which
 * already holds the analysis engine). If the warm path is unavailable, the
 * client resolves `undefined` and the caller falls back to cold local analysis.
 */

import * as crypto from "node:crypto";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { McpAnalyzeResult } from "./analyze.js";

/**
 * Stable per-workspace endpoint path. The server (from its launch cwd) and the
 * hook (from the PostToolUse cwd) must resolve the same path — both hash the
 * resolved root (lowercased for case-insensitive filesystems), so when they're
 * the same project they meet. Mismatch → the client just falls back to cold.
 */
export function ipcPathForCwd(cwd: string): string {
	const root = path.resolve(cwd).toLowerCase();
	// sha256 (not for security — just a stable short id for the IPC socket/pipe
	// name keyed by cwd; sha256 over sha1 keeps SonarCloud's weak-hash check quiet)
	const hash = crypto
		.createHash("sha256")
		.update(root)
		.digest("hex")
		.slice(0, 16);
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\pi-lens-mcp-${hash}`;
	}
	return path.join(os.tmpdir(), `pi-lens-mcp-${hash}.sock`);
}

/** One IPC request: analyze a file in the warm server process. */
export interface WarmAnalyzeRequest {
	file: string;
	cwd: string;
}

/**
 * Ask the warm server to analyze a file. Resolves the server's result, or
 * `undefined` on ANY failure (no server, refused, stale socket, timeout, bad
 * response) so the caller transparently falls back to cold local analysis.
 */
export function requestWarmAnalyze(
	cwd: string,
	file: string,
	timeoutMs = 30_000,
): Promise<McpAnalyzeResult | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: McpAnalyzeResult | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};

		const socket = net.createConnection(ipcPathForCwd(cwd));
		socket.setEncoding("utf8");
		let buffer = "";

		const timer = setTimeout(() => {
			socket.destroy();
			finish(undefined);
		}, timeoutMs);
		timer.unref();

		socket.on("connect", () => {
			const request: WarmAnalyzeRequest = { file, cwd };
			socket.write(`${JSON.stringify(request)}\n`);
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			try {
				const message = JSON.parse(buffer.slice(0, newline)) as {
					result?: McpAnalyzeResult;
					error?: string;
				};
				finish(message.error ? undefined : message.result);
			} catch {
				finish(undefined);
			}
			socket.end();
		});
		// No server / connection refused / reset → cold fallback.
		socket.on("error", () => finish(undefined));
		socket.on("close", () => finish(undefined));
	});
}
