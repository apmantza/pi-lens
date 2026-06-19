/**
 * Shared MCP stdio harness — spawns the in-place-compiled server and drives the
 * real newline-delimited JSON-RPC transport (initialize → tools/list → tools/call)
 * without needing an MCP client. Used by the protocol smoke and the live-LSP
 * validation smoke.
 *
 * Requires `npm run build` first (resolves mcp/server.js next to its source).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const serverJs = path.join(repoRoot, "mcp", "server.js");

export interface McpHarnessOptions {
	/** Project root the server operates on (--cwd). Defaults to the repo root. */
	cwd?: string;
	/** Extra env merged over process.env for the server subprocess. */
	env?: Record<string, string>;
	/** Default per-request timeout (ms). Individual requests can override. */
	defaultTimeoutMs?: number;
}

export class McpHarness {
	private child: ChildProcessWithoutNullStreams;
	private buffer = "";
	private pending = new Map<number, (msg: Record<string, unknown>) => void>();
	private defaultTimeoutMs: number;

	constructor(options: McpHarnessOptions = {}) {
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? 20_000;
		this.child = spawn(
			process.execPath,
			[serverJs, `--cwd=${options.cwd ?? repoRoot}`],
			{
				stdio: ["pipe", "pipe", "pipe"],
				env: options.env ? { ...process.env, ...options.env } : process.env,
			},
		);
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => {
			this.buffer += chunk;
			let nl = this.buffer.indexOf("\n");
			while (nl !== -1) {
				const line = this.buffer.slice(0, nl).trim();
				this.buffer = this.buffer.slice(nl + 1);
				if (line) {
					const msg = JSON.parse(line) as Record<string, unknown>;
					const id = msg.id as number | undefined;
					if (typeof id === "number" && this.pending.has(id)) {
						this.pending.get(id)?.(msg);
						this.pending.delete(id);
					}
				}
				nl = this.buffer.indexOf("\n");
			}
		});
	}

	request(
		id: number,
		method: string,
		params?: unknown,
		timeoutMs = this.defaultTimeoutMs,
	): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`timeout: ${method}`)),
				timeoutMs,
			);
			this.pending.set(id, (msg) => {
				clearTimeout(timer);
				resolve(msg);
			});
			this.child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
			);
		});
	}

	notify(method: string, params?: unknown): void {
		this.child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
		);
	}

	dispose(): void {
		this.child.stdin.end();
		this.child.kill();
	}
}
