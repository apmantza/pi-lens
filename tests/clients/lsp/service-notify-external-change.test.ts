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
});
