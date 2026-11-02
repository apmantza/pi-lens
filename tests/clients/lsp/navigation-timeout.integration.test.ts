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
import { createLspNavigationTool } from "../../../tools/lsp-navigation.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";
import { installLspService } from "../../support/lsp-service-seam.js";

afterEach(() => {
	if (previousTimeout === undefined)
		delete process.env.PI_LENS_LSP_NAV_REQUEST_TIMEOUT_MS;
	else process.env.PI_LENS_LSP_NAV_REQUEST_TIMEOUT_MS = previousTimeout;
});

it("real fake-server documentSymbol timeout is not an empty answer (#5211)", async () => {
	const proc = await spawnFakeLspServer({
		cwd: process.cwd(),
		env: { ...process.env, FAKE_LSP_HANG_DOCUMENT_SYMBOL: "1" },
	});
	const client = await createLSPClient({
		serverId: "fake-document-symbol-timeout-5211",
		process: proc,
		root: process.cwd(),
	});
	try {
		const filePath = path.join(process.cwd(), "timeout-5211.ts");
		await client.notify.open(filePath, "const x = 1;", "typescript");
		await expect(client.documentSymbol(filePath)).rejects.toBeInstanceOf(
			LspRequestTimeoutError,
		);

		const service = new LSPService();
		const realService = service as unknown as {
			supportsLSP: (path: string) => boolean;
			hasLSP: (path: string) => Promise<boolean>;
			touchFile: (path: string, content: string) => Promise<void>;
			getOperationSupport: (path: string) => Promise<unknown>;
			documentSymbol: (path: string) => Promise<unknown>;
		};
		realService.supportsLSP = () => true;
		realService.hasLSP = async () => true;
		realService.touchFile = async () => undefined;
		realService.getOperationSupport = async () => client.getOperationSupport();
		realService.documentSymbol = (requestedPath) =>
			client.documentSymbol(requestedPath);
		installLspService(service);

		const result = await createLspNavigationTool(
			(flag) => flag === "lens-lsp",
		).execute(
			"real-document-symbol-timeout",
			{ operation: "documentSymbol", path: filePath },
			new AbortController().signal,
			null,
			{ cwd: process.cwd() },
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
	}
}, 5000);
