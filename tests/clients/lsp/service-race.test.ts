import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

describe("LSPService race hardening", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("deduplicates concurrent spawn for same server/root key", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const spawn = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return {
				process: {
					process: { killed: false },
					stdin: {} as any,
					stdout: {} as any,
					stderr: {} as any,
					pid: 123,
				},
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
		const [a, b, c] = await Promise.all([
			service.getClientForFile(file),
			service.getClientForFile(file),
			service.getClientForFile(file),
		]);

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(createLSPClient).toHaveBeenCalledTimes(1);
		expect(a?.client).toBeTruthy();
		expect(b?.client).toBeTruthy();
		expect(c?.client).toBeTruthy();
	});

	it("retries broken server after cooldown window", async () => {
		const now = vi.spyOn(Date, "now");
		now.mockReturnValue(0);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const spawn = vi.fn(async () => undefined);
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
		await service.getClientForFile(file);
		await service.getClientForFile(file);
		expect(spawn).toHaveBeenCalledTimes(1);

		now.mockReturnValue(16_000);
		await service.getClientForFile(file);
		expect(spawn).toHaveBeenCalledTimes(2);
		now.mockRestore();
	}, 15000);

	it("does not permanently disable unavailable servers when install is disabled", async () => {
		const savedDisable = process.env.PI_LENS_DISABLE_LSP_INSTALL;
		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		const now = vi.spyOn(Date, "now");

		try {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();

			const spawn = vi.fn(async () => undefined);
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
			for (let i = 0; i < 6; i++) {
				now.mockReturnValue(i * 16_000);
				await service.getClientForFile(file);
			}

			// A normal unavailable server would be permanently disabled after five
			// misses. With install disabled, misses are policy/unavailable outcomes;
			// keep retrying after cooldown so a newly installed PATH binary can recover
			// without resetting the whole LSP service.
			expect(spawn).toHaveBeenCalledTimes(6);
			expect(createLSPClient).not.toHaveBeenCalled();
		} finally {
			now.mockRestore();
			if (savedDisable === undefined) delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
			else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedDisable;
		}
	}, 15000);

	it("uses a server-specific wait budget override for slow startup", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const spawn = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return {
				process: {
					process: { killed: false },
					stdin: {} as any,
					stdout: {} as any,
					stderr: {} as any,
					pid: 456,
				},
			};
		});

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "ruby",
				name: "Ruby LSP",
				extensions: [".rb"],
				root: async () => "C:/repo",
				clientWaitTimeoutMs: 50,
				spawn,
			},
		]);

		const file = "C:/repo/main.rb";
		const result = await service.getClientForFile(file, 1);

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(result?.client).toBeTruthy();
	});
});
