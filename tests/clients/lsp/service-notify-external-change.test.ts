/**
 * #1668 — LSPService.notifyExternalFileChange.
 *
 * Cross-layer seam for a disk change (bash write/delete) that never went
 * through open-document sync. Only reaches ALREADY-ACTIVE clients for the
 * file's matching servers — a server never spawned has no stale cache to
 * correct, so this must never spawn one just to deliver the notification.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

const FILE = "C:/repo/main.ts";

function makeServer(id: string, root = "C:/repo") {
	return {
		id,
		name: id,
		extensions: [".ts"],
		idleEviction: "resident",
		root: async () => root,
		spawn: vi.fn(async () => ({
			process: {
				process: {
					killed: false,
					kill: vi.fn(),
					on: vi.fn(),
					removeListener: vi.fn(),
				},
				stdin: { on: vi.fn(), off: vi.fn(), write: vi.fn() },
				stdout: { on: vi.fn(), off: vi.fn(), pipe: vi.fn() },
				stderr: { on: vi.fn(), off: vi.fn() },
				pid: 999,
			},
			source: "test",
		})),
	};
}

function makeClient() {
	return {
		isAlive: () => true,
		shutdown: vi.fn(async () => {}),
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		diagnosticsVersion: 0,
		getDiagnostics: vi.fn(() => []),
		notify: {
			open: vi.fn(async () => {}),
			change: vi.fn(async () => {}),
			watchedFileChange: vi.fn(),
		},
		waitForDiagnostics: vi.fn(async () => undefined),
	};
}

describe("LSPService.notifyExternalFileChange (#1668)", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("delivers to an already-active client's watch queue via notify.watchedFileChange", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const server = makeServer("typescript");
		const client = makeClient();
		getServersForFileWithConfig.mockReturnValue([server]);
		createLSPClient.mockResolvedValue(client);

		// Spawn the client the normal way first (mirrors an already-open file).
		await service.getClientForFile(FILE);
		expect(client.notify.watchedFileChange).not.toHaveBeenCalled();

		await service.notifyExternalFileChange(FILE, 3);

		expect(client.notify.watchedFileChange).toHaveBeenCalledTimes(1);
		expect(client.notify.watchedFileChange).toHaveBeenCalledWith(FILE, 3);
	});

	it("never spawns a client just to deliver the notification", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const server = makeServer("typescript");
		getServersForFileWithConfig.mockReturnValue([server]);
		createLSPClient.mockResolvedValue(makeClient());

		// No prior getClientForFile call — the server was never spawned.
		await service.notifyExternalFileChange(FILE, 3);

		expect(createLSPClient).not.toHaveBeenCalled();
		expect(server.spawn).not.toHaveBeenCalled();
	});

	it("reaches every matching server, not just the first", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const primary = makeServer("typescript");
		const aux = makeServer("opengrep");
		const primaryClient = makeClient();
		const auxClient = makeClient();
		getServersForFileWithConfig.mockReturnValue([primary, aux]);
		createLSPClient
			.mockResolvedValueOnce(primaryClient)
			.mockResolvedValueOnce(auxClient);

		await service.getClientsForFile(FILE);
		await service.notifyExternalFileChange(FILE, 3);

		expect(primaryClient.notify.watchedFileChange).toHaveBeenCalledTimes(1);
		expect(primaryClient.notify.watchedFileChange).toHaveBeenCalledWith(
			FILE,
			3,
		);
		expect(auxClient.notify.watchedFileChange).toHaveBeenCalledTimes(1);
		expect(auxClient.notify.watchedFileChange).toHaveBeenCalledWith(FILE, 3);
	});

	it("announces a changed file to a live sibling root", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const server = makeServer("typescript");
		const owningClient = makeClient();
		const siblingClient = makeClient();
		getServersForFileWithConfig.mockReturnValue([server]);
		const state = (
			service as unknown as { state: { clients: Map<string, unknown> } }
		).state;
		state.clients.set("typescript:c:/repo", owningClient);
		state.clients.set("typescript:c:/repo/packages/a", siblingClient);
		state.clients.set("typescript-jedi:c:/repo/packages/jedi", makeClient());

		await service.touchFile(FILE, "export type T = 'new';\n");
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(owningClient.notify.watchedFileChange).not.toHaveBeenCalled();
		expect(siblingClient.notify.watchedFileChange).toHaveBeenCalledWith(
			FILE,
			2,
		);
		expect(
			(
				state.clients.get(
					"typescript-jedi:c:/repo/packages/jedi",
				) as ReturnType<typeof makeClient>
			).notify.watchedFileChange,
		).not.toHaveBeenCalled();
	});

	it("announces each distinct touchFile content to a live sibling root", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const server = makeServer("typescript");
		const owningClient = makeClient();
		const siblingClient = makeClient();
		getServersForFileWithConfig.mockReturnValue([server]);
		const state = (
			service as unknown as { state: { clients: Map<string, unknown> } }
		).state;
		state.clients.set("typescript:c:/repo", owningClient);
		state.clients.set("typescript:c:/repo/packages/a", siblingClient);

		await service.touchFile(FILE, "export type T = 'old';\n");
		await service.touchFile(FILE, "export type T = 'new';\n");
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(siblingClient.notify.watchedFileChange).toHaveBeenCalledTimes(2);
	});

	it("records content when no sibling is live, then announces after respawn", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const server = makeServer("typescript");
		const owningClient = makeClient();
		const siblingClient = makeClient();
		getServersForFileWithConfig.mockReturnValue([server]);
		const state = (
			service as unknown as { state: { clients: Map<string, unknown> } }
		).state;
		state.clients.set("typescript:c:/repo", owningClient);
		state.clients.set("typescript:c:/repo/packages/a", siblingClient);

		const announce = (
			service as unknown as {
				announceToSiblings(path: string, content: string): Promise<void>;
			}
		).announceToSiblings.bind(service);
		await announce(FILE, "old");
		state.clients.delete("typescript:c:/repo/packages/a");
		await announce(FILE, "new");
		state.clients.set("typescript:c:/repo/packages/a", siblingClient);
		await announce(FILE, "old");

		expect(siblingClient.notify.watchedFileChange).toHaveBeenCalledTimes(2);
		expect(siblingClient.notify.watchedFileChange).toHaveBeenLastCalledWith(
			FILE,
			2,
		);
	});

	it("records a bounded degradation when sibling notification fails", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const { getDegradationSummary, resetDegradationLedger } =
			await import("../../../clients/degradation-ledger.js");
		resetDegradationLedger();
		const service = new LSPService();
		const server = makeServer("typescript");
		const owningClient = makeClient();
		const siblingClient = makeClient();
		siblingClient.notify.watchedFileChange.mockImplementation(() => {
			throw new Error("watch queue unavailable");
		});
		getServersForFileWithConfig.mockReturnValue([server]);
		const state = (
			service as unknown as { state: { clients: Map<string, unknown> } }
		).state;
		state.clients.set("typescript:c:/repo", owningClient);
		state.clients.set("typescript:c:/repo/packages/a", siblingClient);

		await service.touchFile(FILE, "broken");
		await new Promise<void>((resolve) => setImmediate(resolve));

		const group = getDegradationSummary().find(
			(entry) => entry.kind === "lsp-sibling-announcement",
		);
		expect(group?.count).toBe(1);
	});

	it("notifies same-server sibling roots for external changes", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const server = makeServer("typescript");
		const owningClient = makeClient();
		const siblingClient = makeClient();
		getServersForFileWithConfig.mockReturnValue([server]);
		const state = (
			service as unknown as { state: { clients: Map<string, unknown> } }
		).state;
		state.clients.set("typescript:c:/repo", owningClient);
		state.clients.set("typescript:c:/repo/packages/a", siblingClient);

		await service.notifyExternalFileChange(FILE, 3);

		expect(owningClient.notify.watchedFileChange).toHaveBeenCalledWith(FILE, 3);
		expect(siblingClient.notify.watchedFileChange).toHaveBeenCalledWith(
			FILE,
			3,
		);
	});

	it("does not re-announce unchanged content and bounds the hash table", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const server = makeServer("typescript");
		const siblingClient = makeClient();
		getServersForFileWithConfig.mockReturnValue([server]);
		const state = (
			service as unknown as { state: { clients: Map<string, unknown> } }
		).state;
		state.clients.set("typescript:c:/repo", makeClient());
		state.clients.set("typescript:c:/repo/packages/a", siblingClient);
		const announce = (
			service as unknown as {
				announceToSiblings(path: string, content: string): Promise<void>;
			}
		).announceToSiblings.bind(service);

		await announce("C:/repo/packages/a.ts", "same");
		await announce("C:/repo/packages/a.ts", "same");
		expect(siblingClient.notify.watchedFileChange).toHaveBeenCalledTimes(1);

		for (let index = 0; index < 1025; index += 1) {
			await announce(`C:/repo/packages/${index}.ts`, String(index));
		}
		const hashes = (
			service as unknown as { siblingAnnouncementHashes: { size: number } }
		).siblingAnnouncementHashes;
		expect(hashes.size).toBe(1024);
	});
});
