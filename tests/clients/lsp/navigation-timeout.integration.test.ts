import * as path from "node:path";
import { expect, it, vi } from "vitest";

vi.hoisted(() => {
	process.env.PI_LENS_LSP_NAV_REQUEST_TIMEOUT_MS = "150";
});

import { createLSPClient } from "../../../clients/lsp/client.js";
import { LspRequestTimeoutError } from "../../../clients/lsp/request-timeout-error.js";
import { stopLSP } from "../../../clients/lsp/launch.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";

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
	} finally {
		try {
			await client.shutdown();
		} catch {
			/* ignore */
		}
		await stopLSP(proc);
	}
}, 5000);
