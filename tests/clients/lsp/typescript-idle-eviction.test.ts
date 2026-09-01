import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { suspendAt } from "../interleaving-kit.js";
const recordDegradation = vi.hoisted(() => vi.fn());
vi.mock("../../../clients/degradation-ledger.js", () => ({
	recordDegradation,
}));

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

function fakeClient(label: string, busy = false) {
	return {
		label,
		root: "/repo",
		isAlive: vi.fn(() => true),
		isBusy: vi.fn(() => busy),
		shutdown: vi.fn(async () => undefined),
		notify: {
			open: vi.fn(async () => undefined),
			change: vi.fn(async () => undefined),
		},
		diagnosticsVersion: 0,
		getWorkspaceDiagnosticsSupport: vi.fn(() => ({
			advertised: false,
			mode: "push-only",
			diagnosticProviderKind: "unavailable",
		})),
	};
}

function configureTypeScriptServer() {
	const spawn = vi.fn(async () => ({
		process: {
			process: { killed: false },
			stdin: {},
			stdout: {},
			stderr: {},
			pid: 1332,
		},
	}));
	getServersForFileWithConfig.mockReturnValue([
		{
			id: "typescript",
			name: "TypeScript",
			extensions: [".ts"],
			root: async () => "/repo",
			spawn,
		},
	]);
	return spawn;
}

describe("TypeScript language-service idle eviction (#1332 b2)", () => {
	beforeEach(() => {
		recordDegradation.mockClear();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		process.env.PI_LENS_TS_IDLE_EVICT_MS = "20";
	});

	afterEach(() => {
		delete process.env.PI_LENS_TS_IDLE_EVICT_MS;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("releases the idle client and transparently rebuilds on the next request", async () => {
		vi.useFakeTimers();
		const first = fakeClient("first");
		const rebuilt = fakeClient("rebuilt");
		createLSPClient.mockResolvedValueOnce(first).mockResolvedValueOnce(rebuilt);
		const spawn = configureTypeScriptServer();
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		expect((await service.getClientForFile("/repo/main.ts"))?.client).toBe(
			first,
		);
		await vi.advanceTimersByTimeAsync(20);

		// This is the release assertion: the manager has dropped the only strong
		// client reference and completed the server-owned registry/program teardown.
		expect(service.getAliveClientCount()).toBe(0);
		expect(first.shutdown).toHaveBeenCalledWith({
			reason: "typescript_idle_eviction",
		});
		expect(recordDegradation).toHaveBeenCalledWith({
			kind: "ts-idle-eviction",
			subject: expect.stringMatching(/^typescript:.*repo$/),
			reason: "idle TypeScript client released to bound memory",
		});

		expect((await service.getClientForFile("/repo/main.ts"))?.client).toBe(
			rebuilt,
		);
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(createLSPClient).toHaveBeenCalledTimes(2);
		await service.shutdown();
	});

	it("does not evict an in-flight client and restarts its idle window", async () => {
		vi.useFakeTimers();
		const client = fakeClient("busy", true);
		createLSPClient.mockResolvedValue(client);
		configureTypeScriptServer();
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		await service.getClientForFile("/repo/main.ts");

		await vi.advanceTimersByTimeAsync(20);
		expect(client.shutdown).not.toHaveBeenCalled();
		expect(service.getAliveClientCount()).toBe(1);

		client.isBusy.mockReturnValue(false);
		await vi.advanceTimersByTimeAsync(20);
		expect(client.shutdown).toHaveBeenCalledWith({
			reason: "typescript_idle_eviction",
		});
		expect(service.getAliveClientCount()).toBe(0);
	});

	it("lease-guards the acquire/use gap while didOpen is suspended", async () => {
		vi.useFakeTimers();
		const client = fakeClient("leased");
		createLSPClient.mockResolvedValue(client);
		configureTypeScriptServer();
		const notification = suspendAt(client.notify.open);
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const opened = service.openFile("/repo/main.ts", "const value = 1;");
		await notification.admitted;
		await vi.advanceTimersByTimeAsync(20);

		expect(client.shutdown).not.toHaveBeenCalled();
		expect(service.getAliveClientCount()).toBe(1);
		notification.release();
		await opened;
		expect(client.notify.open).toHaveBeenCalledTimes(1);
		expect(client.shutdown).not.toHaveBeenCalled();
		await service.shutdown();
		notification.restore();
	});

	it("clears TypeScript timer ownership on notify-backpressure eviction", async () => {
		vi.useFakeTimers();
		const client = fakeClient("backpressured");
		createLSPClient.mockResolvedValue(client);
		configureTypeScriptServer();
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const harness = service as unknown as {
			state: { clients: Map<string, typeof client> };
			typeScriptIdleTimers: Map<string, ReturnType<typeof setTimeout>>;
			recordNotifyWriteBackpressure(
				key: string,
				entry: unknown,
				filePath: string,
			): void;
		};
		const entry = await service.getClientForFile("/repo/main.ts");
		expect(entry).toBeDefined();
		expect(harness.typeScriptIdleTimers.size).toBe(1);
		const key = [...harness.state.clients.keys()][0];
		expect(key).toBeDefined();

		for (let attempt = 0; attempt < 3; attempt++) {
			harness.recordNotifyWriteBackpressure(
				key as string,
				entry as NonNullable<typeof entry>,
				"/repo/main.ts",
			);
		}

		expect(harness.typeScriptIdleTimers.size).toBe(0);
		await vi.advanceTimersByTimeAsync(20);
		expect(client.shutdown).toHaveBeenCalledTimes(1);
	});

	it("does not let a stale demotion delete a replacement generation", async () => {
		const predecessor = fakeClient("predecessor");
		const replacement = fakeClient("replacement");
		createLSPClient.mockResolvedValue(predecessor);
		configureTypeScriptServer();
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const entry = await service.getClientForFile("/repo/main.ts");
		expect(entry?.client).toBe(predecessor);
		const harness = service as unknown as {
			state: { clients: Map<string, typeof predecessor> };
			demoteForNotifyStall(
				key: string,
				entry: unknown,
				filePath: string,
				reason: unknown,
			): void;
		};
		const key = [...harness.state.clients.keys()][0];
		harness.state.clients.set(key as string, replacement);
		harness.demoteForNotifyStall(key as string, entry, "/repo/main.ts", {
			outstandingMs: 1,
			discriminator: "budget-exceeded",
		});
		expect(harness.state.clients.get(key as string)).toBe(replacement);
		expect(predecessor.shutdown).not.toHaveBeenCalled();
		await service.shutdown();
	});

	it("keeps token B when stale fireWedge A releases the same client", async () => {
		vi.useFakeTimers();
		const client = fakeClient("same-client");
		createLSPClient.mockResolvedValue(client);
		configureTypeScriptServer();
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const entry = await service.getClientForFile("/repo/main.ts");
		expect(entry?.client).toBe(client);
		const harness = service as unknown as {
			state: { clients: Map<string, typeof client> };
			outstandingAuxNotifyWrites: Map<string, unknown>;
			claimAuxNotifySlot: (
				key: string,
				entry: unknown,
				filePath: string,
				budgetMs: number,
			) => Promise<{ release: () => void } | { outstandingMs: number }>;
		};
		const key = [...harness.state.clients.keys()][0];
		expect(key).toBeDefined();
		const callbacks: Array<() => void> = [];
		const realSetTimeout = globalThis.setTimeout;
		const invokeSetTimeout = realSetTimeout as unknown as (
			...args: unknown[]
		) => ReturnType<typeof setTimeout>;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			handler: (() => void) | string,
			timeout?: number,
			...args: unknown[]
		) => {
			if (typeof handler === "function") {
				const callback = handler as (...callbackArgs: unknown[]) => unknown;
				callbacks.push(() => void callback(...args));
			}
			return invokeSetTimeout(handler, timeout, ...args);
		}) as unknown as typeof setTimeout);
		try {
			const claimA = await harness.claimAuxNotifySlot(
				key as string,
				entry,
				"/repo/main.ts",
				100,
			);
			expect("release" in claimA).toBe(true);
			const callbackA = callbacks.at(-1);
			expect(callbackA).toBeDefined();
			(claimA as { release: () => void }).release();
			const claimB = await harness.claimAuxNotifySlot(
				key as string,
				entry,
				"/repo/main.ts",
				100,
			);
			expect("release" in claimB).toBe(true);
			const tokenB = harness.outstandingAuxNotifyWrites.get(key as string);
			await callbackA?.();
			await Promise.resolve();
			expect(harness.outstandingAuxNotifyWrites.get(key as string)).toBe(
				tokenB,
			);
			(claimB as { release: () => void }).release();
		} finally {
			await service.shutdown();
		}
	});

	it("unrefs the timer and clears it on service disposal", async () => {
		const client = fakeClient("lifecycle");
		createLSPClient.mockResolvedValue(client);
		configureTypeScriptServer();
		const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const harness = service as unknown as {
			typeScriptIdleTimers: Map<string, ReturnType<typeof setTimeout>>;
		};
		await service.getClientForFile("/repo/main.ts");

		const timer = [...harness.typeScriptIdleTimers.values()][0];
		expect(timer).toBeDefined();
		expect(timer.hasRef?.()).toBe(false);
		await service.shutdown();

		expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
		expect(harness.typeScriptIdleTimers.size).toBe(0);
	});
});
