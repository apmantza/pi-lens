// flake-shape: real-process-spawn — the claim is what the real MCP host's language server receives (didOpen/didClose, shutdown); only the real child and its trace can show it
// flake-shape: ungoverned-wait-for — the idle release lands on the server's own timer in the MCP child, so the read waits on the shutdown line with a real-clock deadline (shape 86), never a turn count
/**
 * #5700 through the real MCP host.
 *
 * Recurrences this file prevents:
 * - B1: the MCP host kept every document it ever touched open on the server.
 *   Probed 2026-11-19: 100 files touched once each, `didOpen=100 didClose=0`.
 * - B2/B3: the MCP host has no session idle reset, and a server declared
 *   `unmeasured` (every config-declared server, and 32 built-ins) armed no
 *   per-client idle timer, so such a server lived as long as the MCP process.
 *
 * The server is `tests/fixtures/fake-lsp-server.mjs`, declared through the
 * project's `.pi-lens/lsp.json` the way a user declares one. The cap and the
 * idle window are the registry's two env knobs, lowered for the test.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { McpHarness } from "./harness.js";

const IDLE_MS = 1_500;

function luaWorkspace(prefix: string) {
	const env = setupTestEnvironment(prefix);
	const trace = path.join(env.tmpDir, "server.trace");
	const shim = path.join(env.tmpDir, "server.mjs");
	fs.writeFileSync(
		shim,
		[
			'process.env.FAKE_LSP_NO_DIAGNOSTIC_PROVIDER = "1";',
			'process.env.FAKE_LSP_PUSH_DIAGNOSTIC = "1";',
			`process.env.FAKE_LSP_TRACE_FILE = ${JSON.stringify(trace)};`,
			`await import(${JSON.stringify(new URL("../fixtures/fake-lsp-server.mjs", import.meta.url).href)});`,
			"",
		].join("\n"),
	);
	fs.writeFileSync(path.join(env.tmpDir, ".luarc.json"), "{}\n");
	fs.mkdirSync(path.join(env.tmpDir, ".pi-lens"), { recursive: true });
	fs.writeFileSync(
		path.join(env.tmpDir, ".pi-lens", "lsp.json"),
		JSON.stringify({
			servers: {
				emmylua: {
					name: "budget probe server",
					extensions: [".lua"],
					command: process.execPath,
					args: [shim],
					rootMarkers: [".luarc.json"],
				},
			},
			disabledServers: ["lua", "ast-grep", "typos", "opengrep"],
		}),
	);
	const files = Array.from({ length: 4 }, (_, i) => {
		const file = path.join(env.tmpDir, `probe-${i}.lua`);
		fs.writeFileSync(file, `local value${i} = ${i}\n`);
		return file;
	});
	/** Every message the server read, as `<method> <uri>`. */
	const wire = () =>
		fs.existsSync(trace)
			? fs
					.readFileSync(trace, "utf8")
					.split("\n")
					.flatMap((line) => /^recv (\S+)/.exec(line)?.slice(1, 2) ?? [])
			: [];
	return { env, files, wire };
}

describe("LSP resident budget through the MCP host (#5700)", () => {
	it("caps open documents and releases an idle config-declared server", async () => {
		const { env, files, wire } = luaWorkspace("pi-lens-mcp-5700-");
		const child = new McpHarness({
			cwd: env.tmpDir,
			env: {
				PI_LENS_LSP_OPEN_DOCUMENT_CAP: "2",
				PI_LENS_LSP_IDLE_EVICT_MS: String(IDLE_MS),
				PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS: String(IDLE_MS),
			},
		});
		try {
			for (const [index, file] of files.entries()) {
				await child.request(5700 + index, "tools/call", {
					name: "pilens_diagnostics",
					arguments: {
						source: "lsp",
						scope: "paths",
						paths: [file],
						serverScope: "primary",
						waitMs: 3000,
						severity: "all",
					},
				});
			}
			const methods = wire();
			// Pre-#5700: four didOpens and no didClose.
			expect(methods.filter((m) => m === "textDocument/didOpen")).toHaveLength(
				4,
			);
			expect(methods.filter((m) => m === "textDocument/didClose")).toHaveLength(
				2,
			);

			// Pre-#5700 the server was never released: no shutdown, ever.
			await vi.waitFor(() => expect(wire()).toContain("shutdown"), {
				timeout: IDLE_MS + 15_000,
				interval: 250,
			});
		} finally {
			child.dispose();
			env.cleanup();
		}
	}, 60_000);
});
