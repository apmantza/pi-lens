// flake-shape: real-process-spawn — the probe's requests are read off a real server's wire; a stub cannot show that a server without the capability received none
/**
 * #1969: the liveness probe only sends a method the server advertised.
 *
 * `clientPingLiveness` (#1277) hardcoded `workspace/symbol` because it needs no
 * open document, and counted a `MethodNotFound` reply as proof of life. The
 * round-trip reasoning is sound. The hardcoded method is not: a server that
 * does not implement it logs an error for every probe. ast-grep's tower_lsp
 * backend wrote "got a 'workspace/symbol' request, but it is not implemented"
 * on each one, and its `code=1` deaths clustered after them.
 *
 * The fix picks the probe from the server's advertised capabilities, best
 * first: `workspace/symbol`, then `textDocument/documentSymbol` on an open
 * document, then `textDocument/hover` on an open document, then nothing.
 * ast-grep advertises `hoverProvider` (docs/servercapabilities.md:53), so it
 * keeps a real round-trip rather than falling to the last rung.
 *
 * Assertions are on the WIRE — which method the client actually sends — not on
 * an internal branch, because "does not provoke an error in the server" is a
 * statement about what leaves the process.
 */

import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";

type Client = Awaited<
	ReturnType<typeof import("../../../clients/lsp/client.js").createLSPClient>
>;

async function startClient(env: NodeJS.ProcessEnv = {}): Promise<Client> {
	const { createLSPClient } = await import("../../../clients/lsp/client.js");
	const proc = await spawnFakeLspServer({
		cwd: process.cwd(),
		env,
	});
	return createLSPClient({
		serverId: "fake",
		process: proc,
		root: process.cwd(),
	});
}

function unsupportedGroup() {
	return getDegradationSummary().find(
		(group) => group.kind === "lsp-liveness-probe-unsupported",
	);
}

describe("liveness probe — capability gated (#1969)", () => {
	let client: Client | undefined;

	beforeEach(() => {
		resetDegradationLedger();
	});

	afterEach(async () => {
		if (client) {
			try {
				await client.shutdown();
			} catch {
				/* ignore */
			}
			client = undefined;
		}
		resetDegradationLedger();
	});

	it("sends NO workspace/symbol to a server that advertises no capability it can probe", async () => {
		client = await startClient({
			FAKE_LSP_NO_WORKSPACE_SYMBOL: "1",
			FAKE_LSP_NO_DOCUMENT_SYMBOL: "1",
			FAKE_LSP_NO_HOVER: "1",
		});
		const sendRequest = vi.spyOn(client.connection, "sendRequest");

		const alive = await client.pingLiveness?.(2_000);

		// The probe must not have gone out at all.
		const methods = sendRequest.mock.calls.map((call) => call[0]);
		expect(methods).not.toContain("workspace/symbol");
		expect(methods).toEqual([]);

		// ...and liveness still resolves, from process and connection state.
		expect(alive).toBe(true);

		// The weaker verdict is recorded rather than passed off as the strong
		// one. Deleting that ledger write reds this.
		const group = unsupportedGroup();
		expect(group?.count).toBe(1);
		expect(group?.latestReasons.at(-1)?.subject).toBe("fake");
	}, 15_000);

	// Mutation guard for the gate's POSITIVE arm: a gate that always skipped
	// would pass the test above and red this one.
	it("still sends workspace/symbol when the server advertises workspaceSymbolProvider", async () => {
		client = await startClient();
		const sendRequest = vi.spyOn(client.connection, "sendRequest");

		const alive = await client.pingLiveness?.(2_000);

		expect(sendRequest.mock.calls.map((call) => call[0])).toContain(
			"workspace/symbol",
		);
		expect(alive).toBe(true);
		expect(unsupportedGroup()).toBeUndefined();
	}, 15_000);

	// #1969 review F3: rung 2's own mutation guard. Without this the rung was
	// vacuous — deleting the whole `documentSymbol` branch left the suite green,
	// because every other test either takes rung 1 or falls past rung 2 to hover.
	it("uses textDocument/documentSymbol when documentSymbolProvider is advertised but workspaceSymbolProvider is not", async () => {
		client = await startClient({ FAKE_LSP_NO_WORKSPACE_SYMBOL: "1" });
		const filePath = path.join(process.cwd(), "liveness-probe-rung2.ts");
		await client.notify.open(
			filePath,
			"const probed = true;\n",
			"typescript",
			false,
			true,
		);

		const sendRequest = vi.spyOn(client.connection, "sendRequest");
		const alive = await client.pingLiveness?.(2_000);

		const methods = sendRequest.mock.calls.map((call) => call[0]);
		expect(methods).toContain("textDocument/documentSymbol");
		expect(methods).not.toContain("workspace/symbol");
		// Rung 2 must WIN over rung 3, not merely be reachable. Deleting rung 2
		// falls through to hover, which this catches.
		expect(methods).not.toContain("textDocument/hover");
		expect(alive).toBe(true);
		expect(unsupportedGroup()).toBeUndefined();
	}, 15_000);

	// The ast-grep rung: no symbol provider of either kind, but hoverProvider
	// and an open document, so the round-trip #1714's notify throttle depends
	// on survives — without provoking an unimplemented-method error.
	it("falls back to textDocument/hover on an open document when only hoverProvider is advertised", async () => {
		client = await startClient({
			FAKE_LSP_NO_WORKSPACE_SYMBOL: "1",
			FAKE_LSP_NO_DOCUMENT_SYMBOL: "1",
		});
		const filePath = path.join(process.cwd(), "liveness-probe-fixture.ts");
		await client.notify.open(
			filePath,
			"const probed = true;\n",
			"typescript",
			false,
			true,
		);

		const sendRequest = vi.spyOn(client.connection, "sendRequest");
		const alive = await client.pingLiveness?.(2_000);

		const methods = sendRequest.mock.calls.map((call) => call[0]);
		expect(methods).toContain("textDocument/hover");
		expect(methods).not.toContain("workspace/symbol");
		expect(alive).toBe(true);
		expect(unsupportedGroup()).toBeUndefined();
	}, 15_000);
});
