import { beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

const FILE = "C:/repo/main.py";

function makeFakeProcess() {
	return {
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
	};
}

function makeServer(id: string) {
	return {
		id,
		name: id,
		extensions: [".py"],
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({
			process: makeFakeProcess(),
			source: "test",
		})),
	};
}

function makeDiagnostic(message: string) {
	return {
		severity: 1 as const,
		message,
		range: {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 5 },
		},
	};
}

describe("LSPService.touchFile collectDiagnostics", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});

	it("returns merged diagnostics from touched clients", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const diagnostic = makeDiagnostic("collected error");
		const client = {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			notify: {
				open: vi.fn().mockResolvedValue(undefined),
			},
			waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn(() => [diagnostic, diagnostic]),
		};

		createLSPClient.mockResolvedValue(client);
		getServersForFileWithConfig.mockReturnValue([makeServer("python")]);

		const result = await service.touchFile(FILE, "print('x')\n", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			maxClientWaitMs: 25,
			silent: true,
			source: "test",
		});

		expect(client.notify.open).toHaveBeenCalledWith(
			FILE,
			"print('x')\n",
			"python",
			undefined,
			true,
		);
		expect(client.waitForDiagnostics).toHaveBeenCalledWith(FILE, 25);
		expect(result).toEqual([diagnostic]);
	});

	it("skips notify.open on the second touch with identical content but still waits for diagnostics (#116)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const diagnostic = makeDiagnostic("collected error");
		const client = {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			notify: {
				open: vi.fn().mockResolvedValue(undefined),
			},
			waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn(() => [diagnostic]),
		};

		createLSPClient.mockResolvedValue(client);
		getServersForFileWithConfig.mockReturnValue([makeServer("python")]);

		const content = "print('x')\n";

		// First touch — diagnostics not collected (mirrors the post-write
		// tool_result path which fires touchFile with diagnostics="none").
		await service.touchFile(FILE, content, {
			clientScope: "primary",
			diagnostics: "none",
			collectDiagnostics: false,
			maxClientWaitMs: 25,
			silent: true,
			source: "tool_call:edit",
		});
		expect(client.notify.open).toHaveBeenCalledTimes(1);

		// Second touch — diagnostics collected (mirrors the dispatch-lsp-runner
		// path which fires moments later with the same content). The notify
		// should be skipped, but the diagnostic wait must still happen so the
		// runner returns the LSP's published diagnostics.
		const result = await service.touchFile(FILE, content, {
			clientScope: "primary",
			diagnostics: "document",
			collectDiagnostics: true,
			maxClientWaitMs: 25,
			silent: true,
			source: "dispatch-lsp-runner",
		});

		expect(client.notify.open).toHaveBeenCalledTimes(1);
		expect(client.waitForDiagnostics).toHaveBeenCalledWith(FILE, 25);
		expect(result).toEqual([diagnostic]);
	});

	it("sends notify.open again when the second touch has different content", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const client = {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			notify: { open: vi.fn().mockResolvedValue(undefined) },
			waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn(() => []),
		};

		createLSPClient.mockResolvedValue(client);
		getServersForFileWithConfig.mockReturnValue([makeServer("python")]);

		await service.touchFile(FILE, "print('x')\n", {
			clientScope: "primary",
			diagnostics: "none",
			source: "tool_call:edit",
		});
		await service.touchFile(FILE, "print('y')\n", {
			clientScope: "primary",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "dispatch-lsp-runner",
		});

		expect(client.notify.open).toHaveBeenCalledTimes(2);
	});
});
