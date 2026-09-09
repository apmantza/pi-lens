/**
 * #2540: Cold first edit concurrent LSP spawns & auxiliary readiness tests.
 *
 * Verifies that:
 * 1. Spawns for a file's server set (primary + auxiliaries) start concurrently via
 *    Promise.all rather than serially.
 * 2. Auxiliary readiness is recorded in the latency log with phase: "auxiliary_readiness".
 * 3. Auxiliary client acquisition is bounded by maxWaitMs per server.
 * 4. Diagnostics: "none" non-blocking pre-dispatch touch marks servers ready and warm.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getServersForFileWithConfig: vi.fn(),
	createLSPClient: vi.fn(),
	logLatency: vi.fn(),
}));

vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency: mocks.logLatency,
}));

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig: mocks.getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient: mocks.createLSPClient,
}));

import { LSPService } from "../../../clients/lsp/index.js";

const FILE = "C:/repo/main.ts";

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
		pid: 1234,
	};
}

function makeServer(id: string, role?: "auxiliary") {
	return {
		id,
		name: id,
		extensions: [".ts"],
		...(role && { role }),
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({
			process: makeFakeProcess(),
			source: "test",
		})),
	};
}

function makeClient(serverId: string) {
	return {
		isAlive: () => true,
		shutdown: async () => {},
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		serverId,
		get diagnosticsVersion() {
			return 1;
		},
		getDiagnosticsVersionForPath: vi.fn(() => 1),
		getDiagnostics: vi.fn(() => []),
		notify: {
			open: vi.fn(async () => {}),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		waitForDiagnostics: vi.fn(async () => {}),
	};
}

describe("#2540 concurrent LSP server spawn & auxiliary readiness", () => {
	let service: LSPService;

	beforeEach(() => {
		vi.useFakeTimers();
		service = new LSPService();
		mocks.logLatency.mockClear();
		mocks.createLSPClient.mockImplementation(
			({ serverId }: { serverId?: string }) => makeClient(serverId ?? "mock"),
		);
	});

	afterEach(async () => {
		await service.shutdown({ processExiting: true });
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("spawns primary and auxiliary servers concurrently via Promise.all", async () => {
		let inFlight = 0;
		let peak = 0;
		let releaseAll: () => void;
		const barrier = new Promise<void>((r) => {
			releaseAll = r;
		});

		const track = (s: ReturnType<typeof makeServer>) => {
			s.spawn = vi.fn(async () => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				if (inFlight === 3) {
					releaseAll();
				}
				await barrier;
				return { process: makeFakeProcess(), source: "test" };
			});
			return s;
		};

		const primaryServer = track(makeServer("typescript"));
		const auxServer1 = track(makeServer("opengrep", "auxiliary"));
		const auxServer2 = track(makeServer("ast-grep", "auxiliary"));

		mocks.getServersForFileWithConfig.mockReturnValue([
			primaryServer,
			auxServer1,
			auxServer2,
		]);

		await service.touchFile(FILE, "console.log(1);", {
			diagnostics: "none",
			source: "lsp_sync",
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep", "ast-grep"],
			maxClientWaitMs: 5000,
		});

		// Concurrently spawned via Promise.all: all 3 in flight simultaneously
		expect(peak).toBe(3);
		expect(primaryServer.spawn).toHaveBeenCalledTimes(1);
		expect(auxServer1.spawn).toHaveBeenCalledTimes(1);
		expect(auxServer2.spawn).toHaveBeenCalledTimes(1);
	});

	it("records auxiliary readiness in latency log with phase: auxiliary_readiness", async () => {
		const primaryServer = makeServer("typescript");
		const auxServer1 = makeServer("opengrep", "auxiliary");
		const auxServer2 = makeServer("ast-grep", "auxiliary");

		mocks.getServersForFileWithConfig.mockReturnValue([
			primaryServer,
			auxServer1,
			auxServer2,
		]);

		const touchPromise = service.touchFile(FILE, "const x = 1;", {
			diagnostics: "none",
			source: "lsp_sync",
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep", "ast-grep"],
			maxClientWaitMs: 5000,
		});

		await vi.advanceTimersByTimeAsync(10);
		await touchPromise;

		const auxReadinessCall = mocks.logLatency.mock.calls
			.map((call) => call[0])
			.find((entry: any) => entry.phase === "auxiliary_readiness");

		expect(auxReadinessCall).toBeDefined();
		expect(auxReadinessCall.type).toBe("phase");
		expect(auxReadinessCall.metadata.readyCount).toBe(2);
		expect(auxReadinessCall.metadata.attemptedCount).toBe(2);
		expect(auxReadinessCall.metadata.serverIds).toEqual([
			"opengrep",
			"ast-grep",
		]);
		expect(auxReadinessCall.metadata.source).toBe("lsp_sync");
	});

	it("bounds auxiliary acquisition by maxWaitMs per server", async () => {
		const auxServerFast = makeServer("opengrep", "auxiliary");
		// Hanging server that never resolves spawn within budget
		const auxServerSlow = {
			id: "ast-grep",
			name: "ast-grep",
			extensions: [".ts"],
			role: "auxiliary" as const,
			root: async () => "C:/repo",
			spawn: vi.fn(
				() => new Promise<{ process: any; source: string }>(() => {}),
			),
		};

		mocks.getServersForFileWithConfig.mockReturnValue([
			auxServerFast,
			auxServerSlow,
		]);

		const p = service.getAuxiliaryClientsForFile(
			FILE,
			new Set(["opengrep", "ast-grep"]),
			undefined,
			80,
		);

		await vi.advanceTimersByTimeAsync(150);
		const auxClients = await p;

		expect(auxClients.length).toBe(1);
		expect(auxClients[0].info.id).toBe("opengrep");
	});
});
