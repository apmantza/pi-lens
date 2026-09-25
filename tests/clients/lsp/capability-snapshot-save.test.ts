// #3407: the capability snapshot reports what each server's
// `textDocumentSync.save` asked for, so the inventory can answer "which servers
// receive textDocument/didSave" from the initialize handshake it already reads.
import { describe, expect, it } from "vitest";
import { LSPService } from "../../../clients/lsp/index.js";

function clientDouble(
	getSaveOptions?: () => { includeText: boolean } | undefined,
) {
	return {
		isAlive: () => true,
		root: "/workspace",
		getOperationSupport: () => ({}),
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getAdvertisedCommands: () => [],
		getRawCapabilityKeys: () => ["textDocumentSync"],
		...(getSaveOptions ? { getSaveOptions } : {}),
	};
}

describe("capability snapshot textDocumentSave (#3407)", () => {
	it("maps each negotiated save shape, and a client without the accessor to unknown", async () => {
		const service = new LSPService();
		const clients = (
			service as unknown as { state: { clients: Map<string, unknown> } }
		).state.clients;
		clients.set(
			"fsharp:/workspace",
			clientDouble(() => ({ includeText: true })),
		);
		clients.set(
			"expert:/workspace",
			clientDouble(() => ({ includeText: false })),
		);
		clients.set(
			"vue:/workspace",
			clientDouble(() => undefined),
		);
		clients.set("legacy:/workspace", clientDouble());
		try {
			const byServer = Object.fromEntries(
				(await service.getCapabilitySnapshots()).map((snapshot) => [
					snapshot.serverId,
					snapshot.textDocumentSave,
				]),
			);
			expect(byServer).toEqual({
				fsharp: "save+text",
				expert: "save",
				vue: "none",
				legacy: undefined,
			});
		} finally {
			clients.clear();
		}
	});
});
