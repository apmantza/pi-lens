// flake-shape: real-process-spawn — the real JSON-RPC deadline and cross-evaluation service delivery require a real LSP child; lsp-spawn-heavy serializes it.
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const previousTimeout = vi.hoisted(() => {
	const previous = process.env.PI_LENS_LSP_NAV_REQUEST_TIMEOUT_MS;
	process.env.PI_LENS_LSP_NAV_REQUEST_TIMEOUT_MS = "150";
	return previous;
});

import { createLSPClient } from "../../../clients/lsp/client.js";
import { LspRequestTimeoutError } from "../../../clients/lsp/request-timeout-error.js";
import { LSPService } from "../../../clients/lsp/index.js";
import { stopLSP } from "../../../clients/lsp/launch.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { setupTestEnvironment } from "../test-utils.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";

afterEach(() => {
	if (previousTimeout === undefined)
		delete process.env.PI_LENS_LSP_NAV_REQUEST_TIMEOUT_MS;
	else process.env.PI_LENS_LSP_NAV_REQUEST_TIMEOUT_MS = previousTimeout;
});

it("real fake-server documentSymbol timeout is not an empty answer (#5211)", async () => {
	const fixture = setupTestEnvironment("pi-lens-navigation-timeout-");
	const filePath = path.join(fixture.tmpDir, "timeout-5211.ts");
	fs.writeFileSync(filePath, "const x = 1;");
	fs.writeFileSync(path.join(fixture.tmpDir, "package.json"), "{}");
	fs.writeFileSync(path.join(fixture.tmpDir, "tsconfig.json"), "{}");
	const proc = await spawnFakeLspServer({
		cwd: fixture.tmpDir,
		env: { ...process.env, FAKE_LSP_HANG_DOCUMENT_SYMBOL: "1" },
	});
	const client = await createLSPClient({
		serverId: "fake-document-symbol-timeout-5211",
		process: proc,
		root: fixture.tmpDir,
	});
	try {
		await client.notify.open(filePath, "const x = 1;", "typescript");
		await expect(client.documentSymbol(filePath)).rejects.toBeInstanceOf(
			LspRequestTimeoutError,
		);

		const service = new LSPService();
		// Use production server/root selection, retaining the client from the old
		// evaluation while the tool and its timeout class are re-evaluated (#5211).
		(
			service as unknown as { state: { clients: Map<string, unknown> } }
		).state.clients.set(
			`typescript:${normalizeMapKey(fixture.tmpDir)}`,
			client,
		);
		expect((await service.getClientForFile(filePath))?.client).toBe(client);
		vi.resetModules();
		const { createLspNavigationTool } =
			await import("../../../tools/lsp-navigation.js");
		const { installLspService } =
			await import("../../support/lsp-service-seam.js");
		const freshTimeoutModule =
			await import("../../../clients/lsp/request-timeout-error.js");
		expect(freshTimeoutModule.LspRequestTimeoutError).not.toBe(
			LspRequestTimeoutError,
		);
		installLspService(service);

		const result = await createLspNavigationTool(
			(flag) => flag === "lens-lsp",
		).execute(
			"real-document-symbol-timeout",
			{ operation: "documentSymbol", path: filePath },
			new AbortController().signal,
			null,
			{ cwd: fixture.tmpDir },
		);
		const envelope = JSON.parse(String(result.content[0]?.text)) as Record<
			string,
			unknown
		>;
		expect(result.isError).toBe(true);
		expect(envelope).toMatchObject({
			ok: false,
			status: "timeout",
			metadata: {
				method: "textDocument/documentSymbol",
			},
		});
		expect((envelope.metadata as { elapsedMs?: unknown }).elapsedMs).toEqual(
			expect.any(Number),
		);
	} finally {
		try {
			await client.shutdown();
		} catch {
			/* ignore */
		}
		await stopLSP(proc);
		fixture.cleanup();
	}
}, 5000);

// #5214 F4: definition deadlines must retain local recovery without hiding failure.
it.each([
	{ outcome: "hit", token: "greet", hangSymbols: false },
	{ outcome: "miss", token: "absent", hangSymbols: false },
	{ outcome: "both timeout", token: "greet", hangSymbols: true },
])(
	"definition timeout fallback $outcome (#5214 F4)",
	async ({ outcome, token, hangSymbols }) => {
		const fixture = setupTestEnvironment("pi-lens-definition-timeout-");
		const filePath = path.join(fixture.tmpDir, "definition.ts");
		const content = `function ${token}() {}\n`;
		fs.writeFileSync(filePath, content);
		fs.writeFileSync(path.join(fixture.tmpDir, "package.json"), "{}");
		fs.writeFileSync(path.join(fixture.tmpDir, "tsconfig.json"), "{}");
		const proc = await spawnFakeLspServer({
			cwd: fixture.tmpDir,
			env: {
				...process.env,
				FAKE_LSP_HANG_DEFINITION: "1",
				FAKE_LSP_HANG_DOCUMENT_SYMBOL: hangSymbols ? "1" : "0",
			},
		});
		const client = await createLSPClient({
			serverId: "fake-definition-timeout-5214",
			process: proc,
			root: fixture.tmpDir,
		});
		try {
			await client.notify.open(filePath, content, "typescript");
			const service = new LSPService();
			(
				service as unknown as { state: { clients: Map<string, unknown> } }
			).state.clients.set(
				`typescript:${normalizeMapKey(fixture.tmpDir)}`,
				client,
			);
			expect((await service.getClientForFile(filePath))?.client).toBe(client);
			const { createLspNavigationTool } =
				await import("../../../tools/lsp-navigation.js");
			const { installLspService } =
				await import("../../support/lsp-service-seam.js");
			installLspService(service);
			const result = await createLspNavigationTool(
				(flag) => flag === "lens-lsp",
			).execute(
				"definition-timeout-fallback",
				{ operation: "definition", path: filePath, line: 1, character: 11 },
				new AbortController().signal,
				null,
				{ cwd: fixture.tmpDir },
			);
			const text = String(result.content[0]?.text);
			const envelope = JSON.parse(text);
			if (outcome === "hit") {
				expect(result.isError).not.toBe(true);
				expect(envelope.notes).toContain(
					"served from documentSymbol fallback; definition timed out.",
				);
				expect(envelope.locations).toMatchObject([
					{ filePath, range: { start: { line: 1, character: 1 } } },
				]);
				expect(text).toContain("definition timed out");
				expect(text).toContain("definition.ts");
			} else {
				expect(result.isError).toBe(true);
				expect(envelope).toMatchObject({
					ok: false,
					status: "timeout",
					metadata: { method: "textDocument/definition" },
				});
			}
		} finally {
			try {
				await client.shutdown();
			} catch {
				/* ignore */
			}
			await stopLSP(proc);
			fixture.cleanup();
		}
	},
	5000,
);
