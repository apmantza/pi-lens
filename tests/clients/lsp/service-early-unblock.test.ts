/**
 * LSP Service — early-unblock diagnostic aggregation tests
 *
 * Verifies that getDiagnostics() returns before the full DIAGNOSTICS_AGGREGATE_WAIT_MS
 * when the fastest client finishes and the grace window elapses, instead of always
 * waiting for the slowest client.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

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
		pid: 999,
	};
}

function makeServer(id: string) {
	return {
		id,
		name: id,
		extensions: [".ts"],
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

describe("getDiagnostics early-unblock", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns fast client diagnostics without waiting for slow client", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		let resolveSlowWait: () => void = () => {};

		const fastClient = {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			waitForDiagnostics: vi.fn(
				() => new Promise<void>((resolve) => setTimeout(resolve, 100)),
			),
			getDiagnostics: vi.fn(() => [makeDiagnostic("fast error")]),
		};

		const slowClient = {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			waitForDiagnostics: vi.fn(
				// Resolves only when resolveSlowWait is called (or test ends)
				() =>
					new Promise<void>((resolve) => {
						resolveSlowWait = resolve;
						setTimeout(resolve, 5000);
					}),
			),
			getDiagnostics: vi.fn(() => []),
		};

		createLSPClient
			.mockResolvedValueOnce(fastClient)
			.mockResolvedValueOnce(slowClient);

		const serverA = makeServer("ts-fast");
		const serverB = makeServer("ts-slow");
		getServersForFileWithConfig.mockReturnValue([serverA, serverB]);

		// Warm both clients into the cache
		await service.getClientsForFile(FILE);

		// Start the diagnostics aggregation
		const diagPromise = service.getDiagnostics(FILE);

		// Advance to 100ms — fast client's waitForDiagnostics resolves
		await vi.advanceTimersByTimeAsync(100);

		// Advance by EARLY_UNBLOCK_GRACE_MS (400ms default) — grace window expires
		await vi.advanceTimersByTimeAsync(400);

		const result = await diagPromise;

		expect(result).toHaveLength(1);
		expect(result[0].message).toBe("fast error");

		// Slow client's waitForDiagnostics was started but we did not wait its full 5000ms
		expect(slowClient.waitForDiagnostics).toHaveBeenCalled();
		expect(slowClient.getDiagnostics).not.toHaveBeenCalled();
	});

	it("returns all diagnostics when both clients finish within the grace window", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const clientA = {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			waitForDiagnostics: vi.fn(
				() => new Promise<void>((resolve) => setTimeout(resolve, 100)),
			),
			getDiagnostics: vi.fn(() => [makeDiagnostic("error from A")]),
		};

		const clientB = {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			waitForDiagnostics: vi.fn(
				() => new Promise<void>((resolve) => setTimeout(resolve, 300)),
			),
			getDiagnostics: vi.fn(() => [makeDiagnostic("error from B")]),
		};

		createLSPClient
			.mockResolvedValueOnce(clientA)
			.mockResolvedValueOnce(clientB);

		const serverA = makeServer("ts-a");
		const serverB = makeServer("ts-b");
		getServersForFileWithConfig.mockReturnValue([serverA, serverB]);

		await service.getClientsForFile(FILE);

		const diagPromise = service.getDiagnostics(FILE);

		// Advance to 300ms — both clients done (A at 100ms, B at 300ms)
		// Grace window (400ms from A finishing) has not expired yet (100+400=500)
		// But Promise.all wins first since both are done by 300ms
		await vi.advanceTimersByTimeAsync(300);
		// Advance a tiny bit to settle microtasks
		await vi.advanceTimersByTimeAsync(10);

		const result = await diagPromise;

		expect(result.map((d) => d.message).sort()).toEqual([
			"error from A",
			"error from B",
		]);
	});

	it("skips early-unblock with a single client", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const onlyClient = {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			waitForDiagnostics: vi.fn(
				() => new Promise<void>((resolve) => setTimeout(resolve, 200)),
			),
			getDiagnostics: vi.fn(() => [makeDiagnostic("solo error")]),
		};

		createLSPClient.mockResolvedValueOnce(onlyClient);

		getServersForFileWithConfig.mockReturnValue([makeServer("ts-only")]);

		await service.getClientsForFile(FILE);

		const diagPromise = service.getDiagnostics(FILE);

		// Only advance enough for the single client to finish
		await vi.advanceTimersByTimeAsync(200);
		await vi.advanceTimersByTimeAsync(10);

		const result = await diagPromise;

		expect(result).toHaveLength(1);
		expect(result[0].message).toBe("solo error");
	});

	it("deduplicates diagnostics with the same position and message across clients", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const sharedDiag = makeDiagnostic("shared error");

		const clientA = {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			waitForDiagnostics: vi.fn(
				() => new Promise<void>((resolve) => setTimeout(resolve, 50)),
			),
			getDiagnostics: vi.fn(() => [sharedDiag, makeDiagnostic("unique A")]),
		};

		const clientB = {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			waitForDiagnostics: vi.fn(
				() => new Promise<void>((resolve) => setTimeout(resolve, 150)),
			),
			getDiagnostics: vi.fn(() => [sharedDiag, makeDiagnostic("unique B")]),
		};

		createLSPClient
			.mockResolvedValueOnce(clientA)
			.mockResolvedValueOnce(clientB);

		getServersForFileWithConfig.mockReturnValue([
			makeServer("ts-a"),
			makeServer("ts-b"),
		]);

		await service.getClientsForFile(FILE);

		const diagPromise = service.getDiagnostics(FILE);
		await vi.advanceTimersByTimeAsync(150);
		await vi.advanceTimersByTimeAsync(10);

		const result = await diagPromise;

		// shared error should appear only once
		const messages = result.map((d) => d.message);
		expect(messages.filter((m) => m === "shared error")).toHaveLength(1);
		expect(messages).toContain("unique A");
		expect(messages).toContain("unique B");
		expect(result).toHaveLength(3);
	});
});
