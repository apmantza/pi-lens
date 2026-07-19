/**
 * Regression test for #706: shutdown() racing an in-flight spawnClient must
 * not leave a live server process or a registered client behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

describe("LSPService spawn-shutdown race (#706)", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("kills a freshly spawned process when shutdown races spawn before createLSPClient", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Control the spawn timing so we can inject shutdown mid-spawn
		let resolveSpawn!: (value: unknown) => void;
		const spawnGate = new Promise((res) => {
			resolveSpawn = res;
		});

		const mockKill = vi.fn();
		const spawn = vi.fn(async () => {
			await spawnGate;
			return {
				process: {
					process: { killed: false, kill: mockKill },
					stdin: {} as any,
					stdout: {} as any,
					stderr: {} as any,
					pid: 999,
				},
			};
		});

		const clientShutdown = vi.fn().mockResolvedValue(undefined);
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: clientShutdown,
			serverId: "python",
		});

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "python",
				name: "Python",
				extensions: [".py"],
				root: async () => "C:/repo",
				spawn,
			},
		]);

		const file = "C:/repo/main.py";

		// Start the spawn (will hang at spawnGate)
		const spawnPromise = service.getClientForFile(file);

		// Shut down the service while spawn is still pending
		const shutdownPromise = service.shutdown();

		// Let the spawn resolve — service is already destroyed at this point
		resolveSpawn(undefined);

		await shutdownPromise;
		await spawnPromise;

		// The raw process should have been killed (Guard 1)
		expect(mockKill).toHaveBeenCalled();
		// createLSPClient should not have been called at all since guard fires first
		expect(createLSPClient).not.toHaveBeenCalled();
		// state.clients must remain empty
		expect(service.getAliveClientCount()).toBe(0);
		expect(service.getStatus()).toHaveLength(0);
	});

	it("shuts down client when shutdown races spawn after createLSPClient", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Spawn is gated so we can let it resolve, then call shutdown, then
		// release createLSPClient — ensuring Guard 2 (post-initialize) fires.
		let resolveSpawn!: (value: unknown) => void;
		const spawnGate = new Promise((res) => {
			resolveSpawn = res;
		});

		const spawn = vi.fn(async () => {
			await spawnGate;
			return {
				process: {
					process: { killed: false, kill: vi.fn() },
					stdin: {} as any,
					stdout: {} as any,
					stderr: {} as any,
					pid: 998,
				},
			};
		});

		let resolveClient!: (value: unknown) => void;
		const clientGate = new Promise((res) => {
			resolveClient = res;
		});

		const clientShutdown = vi.fn().mockResolvedValue(undefined);
		createLSPClient.mockImplementation(async () => {
			await clientGate;
			return {
				isAlive: () => true,
				shutdown: clientShutdown,
				serverId: "python",
			};
		});

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "python",
				name: "Python",
				extensions: [".py"],
				root: async () => "C:/repo",
				spawn,
			},
		]);

		const file = "C:/repo/main.py";

		// Start the spawn (blocked at spawnGate)
		const spawnPromise = service.getClientForFile(file);

		// Let spawn resolve while service is still alive — Guard 1 won't fire.
		// We need createLSPClient to be entered before shutdown() sets isDestroyed.
		// Use a flag set by the mock to know when that happens.
		let clientEntered = false;
		const origImpl = createLSPClient.getMockImplementation()!;
		createLSPClient.mockImplementation(async (...args: unknown[]) => {
			clientEntered = true;
			return origImpl(...args);
		});

		resolveSpawn(undefined);
		// Spin until createLSPClient is entered
		while (!clientEntered) {
			await Promise.resolve();
		}

		// Now shut down while createLSPClient is still pending (Guard 2 path)
		const shutdownPromise = service.shutdown();

		// Release createLSPClient — service is already destroyed
		resolveClient(undefined);

		await shutdownPromise;
		await spawnPromise;

		// Guard 2: client.shutdown should have been called best-effort
		expect(clientShutdown).toHaveBeenCalled();
		// The leaked client must not be in state.clients
		expect(service.getAliveClientCount()).toBe(0);
		expect(service.getStatus()).toHaveLength(0);
	});
});
