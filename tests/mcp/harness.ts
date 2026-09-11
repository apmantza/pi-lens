/**
 * Shared MCP stdio harness — spawns the in-place-compiled server and drives the
 * real newline-delimited JSON-RPC transport (initialize → tools/list → tools/call)
 * without needing an MCP client. Used by the protocol smoke and the live-LSP
 * validation smoke.
 *
 * Requires `npm run build` first (resolves mcp/server.js next to its source).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	diagnosticsIpcPathForCwd,
	ipcPathForCwd,
} from "../../clients/mcp/ipc.js";

export const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const serverJs = path.join(repoRoot, "mcp", "server.js");
const DEFAULT_TIMEOUT_MS = 20_000;

// Spawn-heavy MCP smokes keep a tight local deadline, while CI can compensate
// for a loaded runner without changing the production server's budgets.
const testTimeoutScale = (() => {
	const parsed = Number(process.env.PI_LENS_TEST_TIMEOUT_SCALE ?? "1");
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
})();

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
	private readonly workspaceDir: string;
	private readonly isolationDir: string;
	private pending = new Map<number, (msg: Record<string, unknown>) => void>();
	private defaultTimeoutMs: number;

	constructor(options: McpHarnessOptions = {}) {
		this.defaultTimeoutMs =
			options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS * testTimeoutScale;
		// Never let a spawn smoke bind the developer's real workspace endpoint or
		// write project/global pi-lens state. Explicit cwd values in these tests are
		// already temp fixtures; the default gets one too.
		this.workspaceDir =
			options.cwd ??
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-mcp-workspace-"));
		if (path.resolve(this.workspaceDir) === path.resolve(repoRoot)) {
			throw new Error(
				"MCP smoke harness refuses the real workspace IPC endpoint",
			);
		}
		this.isolationDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-mcp-isolation-"),
		);
		const env = {
			...process.env,
			PILENS_DATA_DIR:
				options.env?.PILENS_DATA_DIR ?? path.join(this.isolationDir, "data"),
			PI_LENS_HOME:
				options.env?.PI_LENS_HOME ?? path.join(this.isolationDir, "home"),
			...options.env,
		};
		if (
			path.resolve(env.PILENS_DATA_DIR) ===
			path.join(path.resolve(repoRoot), ".pi-lens")
		) {
			throw new Error("MCP smoke harness refuses the real project data root");
		}
		this.child = spawn(
			process.execPath,
			[serverJs, `--cwd=${this.workspaceDir}`],
			{
				stdio: ["pipe", "pipe", "pipe"],
				env,
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

	closeInput(): Promise<void> {
		return new Promise((resolve) => {
			this.child.once("exit", () => resolve());
			this.child.stdin.end();
		});
	}

	dispose(): void {
		this.child.stdin.end();
		this.child.kill();
		// The server binds a stable per-workspace socket (clients/mcp/ipc.ts)
		// that survives the child: every fresh-workspace harness run mints a
		// new socket path, so dispose unlinks this run's endpoints (#2912).
		// Production servers rebind the same stable path per workspace, so
		// this is test-only lifecycle, not a production leak.
		for (const endpoint of [
			ipcPathForCwd(this.workspaceDir),
			diagnosticsIpcPathForCwd(this.workspaceDir, this.child.pid ?? 0),
		]) {
			try {
				fs.rmSync(endpoint, { force: true });
			} catch {
				// Best effort: the server may never have bound (early exit).
			}
		}
		if (!this.workspaceDir || this.workspaceDir !== process.cwd()) {
			fs.rmSync(this.workspaceDir, { recursive: true, force: true });
		}
		fs.rmSync(this.isolationDir, { recursive: true, force: true });
	}
}
