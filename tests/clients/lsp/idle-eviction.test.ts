import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { suspendAt } from "../interleaving-kit.js";
const recordDegradation = vi.hoisted(() => vi.fn());
vi.mock("../../../clients/degradation-ledger.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/degradation-ledger.js")
	>()),
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

function configureServer(
	id = "typescript",
	policy = "transparent",
	root = "/repo",
) {
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
			id,
			name: id,
			extensions: [".ts"],
			idleEviction: policy,
			root: async () => root,
			spawn,
		},
	]);
	return spawn;
}

describe("LSP idle eviction (#1332 b2)", () => {
	beforeEach(() => {
		recordDegradation.mockClear();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		process.env.PI_LENS_TS_IDLE_EVICT_MS = "20";
	});

	afterEach(() => {
		delete process.env.PI_LENS_TS_IDLE_EVICT_MS;
		delete process.env.PI_LENS_LSP_IDLE_EVICT_MS;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// #3645 recurrence: the window was named for one server family
	// (`PI_LENS_TS_IDLE_EVICT_MS`) although it governs every transparent server.
	// The generic spelling must win, the legacy one must keep its meaning, and
	// the 20-minute default must not move.
	describe("idle window env spellings (#3645)", () => {
		const twentyMinutes = 20 * 60_000;

		it("keeps the 20-minute default when neither spelling is set", async () => {
			delete process.env.PI_LENS_TS_IDLE_EVICT_MS;
			const { getLspIdleEvictMs } =
				await import("../../../clients/lsp/index.js");
			expect(getLspIdleEvictMs()).toBe(twentyMinutes);
		});

		it("still honors the legacy PI_LENS_TS_IDLE_EVICT_MS on its own", async () => {
			process.env.PI_LENS_TS_IDLE_EVICT_MS = "1500";
			const { getLspIdleEvictMs } =
				await import("../../../clients/lsp/index.js");
			expect(getLspIdleEvictMs()).toBe(1500);
		});

		it("lets PI_LENS_LSP_IDLE_EVICT_MS win over the legacy spelling", async () => {
			process.env.PI_LENS_TS_IDLE_EVICT_MS = "1500";
			process.env.PI_LENS_LSP_IDLE_EVICT_MS = "2500";
			const { getLspIdleEvictMs } =
				await import("../../../clients/lsp/index.js");
			expect(getLspIdleEvictMs()).toBe(2500);
		});

		it("falls through an invalid generic value to the legacy one, then the default", async () => {
			process.env.PI_LENS_LSP_IDLE_EVICT_MS = "soon";
			process.env.PI_LENS_TS_IDLE_EVICT_MS = "1500";
			const { getLspIdleEvictMs } =
				await import("../../../clients/lsp/index.js");
			expect(getLspIdleEvictMs()).toBe(1500);
			process.env.PI_LENS_TS_IDLE_EVICT_MS = "-4";
			expect(getLspIdleEvictMs()).toBe(twentyMinutes);
		});

		it("evicts on the generic window through the service timer", async () => {
			vi.useFakeTimers();
			delete process.env.PI_LENS_TS_IDLE_EVICT_MS;
			process.env.PI_LENS_LSP_IDLE_EVICT_MS = "20";
			const client = fakeClient("generic-window");
			createLSPClient.mockResolvedValue(client);
			configureServer();
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();
			await service.getClientForFile("/repo/main.ts");
			await vi.advanceTimersByTimeAsync(20);
			expect(client.shutdown).toHaveBeenCalledWith({ reason: "idle_eviction" });
			expect(service.getAliveClientCount()).toBe(0);
		});
	});

	// Recurrence (#1129 F8, review mutation M6): the service timer read the
	// generic window, so a tmp checkout's client sat idle for 20 minutes while
	// only the pure window selector was tested.
	it("evicts a tmp checkout's client on the ephemeral window through the service timer (#1129)", async () => {
		const fs = await import("node:fs");
		const os = await import("node:os");
		const path = await import("node:path");
		const checkout = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-1129-idle-timer-"),
		);
		try {
			fs.mkdirSync(path.join(checkout, ".git", "objects"), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(checkout, ".git", "HEAD"),
				"ref: refs/heads/main\n",
			);
			vi.useFakeTimers();
			delete process.env.PI_LENS_TS_IDLE_EVICT_MS;
			process.env.PI_LENS_LSP_IDLE_EVICT_MS = "100000";
			process.env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS = "20";
			const client = fakeClient("ephemeral-window");
			createLSPClient.mockResolvedValue(client);
			configureServer("typescript", "transparent", checkout);
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();
			await service.getClientForFile(path.join(checkout, "main.ts"));
			await vi.advanceTimersByTimeAsync(20);
			expect(client.shutdown).toHaveBeenCalledWith({
				reason: "idle_eviction",
			});
			expect(service.getAliveClientCount()).toBe(0);
		} finally {
			delete process.env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS;
			fs.rmSync(checkout, { recursive: true, force: true });
		}
	});

	it("releases the idle client and transparently rebuilds on the next request", async () => {
		vi.useFakeTimers();
		const first = fakeClient("first");
		const rebuilt = fakeClient("rebuilt");
		createLSPClient.mockResolvedValueOnce(first).mockResolvedValueOnce(rebuilt);
		const spawn = configureServer();
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
			reason: "idle_eviction",
		});
		expect(recordDegradation).toHaveBeenCalledWith({
			kind: "lsp-idle-eviction",
			subject: expect.stringMatching(/^typescript:.*repo$/),
			reason: "idle LSP client released to bound memory",
		});

		expect((await service.getClientForFile("/repo/main.ts"))?.client).toBe(
			rebuilt,
		);
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(createLSPClient).toHaveBeenCalledTimes(2);
		await service.shutdown();
	});

	// #3645 recurrence: #3622 widened a key-prefix regex (`typescript|python|...`)
	// one server at a time. The registry declaration is the only gate now, so a
	// server id no list has ever heard of is evicted when it declares
	// `transparent`.
	it("releases an idle transparent server whatever its id and rebuilds it on demand", async () => {
		vi.useFakeTimers();
		const first = fakeClient("first");
		const rebuilt = fakeClient("rebuilt");
		createLSPClient.mockResolvedValueOnce(first).mockResolvedValueOnce(rebuilt);
		configureServer("brand-new-server");
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		await service.getClientForFile("/repo/main.ts");
		await vi.advanceTimersByTimeAsync(20);
		expect(first.shutdown).toHaveBeenCalledTimes(1);
		expect(service.getAliveClientCount()).toBe(0);
		expect((await service.getClientForFile("/repo/main.ts"))?.client).toBe(
			rebuilt,
		);
		await service.shutdown();
	});

	it("keeps an unmeasured server resident", async () => {
		vi.useFakeTimers();
		const client = fakeClient("unmeasured");
		createLSPClient.mockResolvedValue(client);
		configureServer("go", "unmeasured");
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		await service.getClientForFile("/repo/main.ts");
		await vi.advanceTimersByTimeAsync(20);
		expect(client.shutdown).not.toHaveBeenCalled();
		expect(service.getAliveClientCount()).toBe(1);
		await service.shutdown();
	});

	it("does not evict an in-flight client and restarts its idle window", async () => {
		vi.useFakeTimers();
		const client = fakeClient("busy", true);
		createLSPClient.mockResolvedValue(client);
		configureServer();
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		await service.getClientForFile("/repo/main.ts");

		await vi.advanceTimersByTimeAsync(20);
		expect(client.shutdown).not.toHaveBeenCalled();
		expect(service.getAliveClientCount()).toBe(1);

		client.isBusy.mockReturnValue(false);
		await vi.advanceTimersByTimeAsync(20);
		expect(client.shutdown).toHaveBeenCalledWith({
			reason: "idle_eviction",
		});
		expect(service.getAliveClientCount()).toBe(0);
	});

	// Review round 1 item 7: the `clientLastUsedAt !== lastUsedAt` re-arm guard is
	// live. A timer that fired and queued behind the spawn gate must not release
	// a client that was used while it waited; without the guard this evicted a
	// client one tick after its own use ("expected shutdown to not be called,
	// called 1 times").
	it("does not evict a client used between the timer firing and the spawn gate admitting it", async () => {
		vi.useFakeTimers();
		const client = fakeClient("used-while-queued");
		createLSPClient.mockResolvedValue(client);
		configureServer();
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		await service.getClientForFile("/repo/main.ts");
		const gateHolder = service as unknown as {
			withClientSpawnGate<T>(op: () => Promise<T>): Promise<T>;
		};
		let open!: () => void;
		const held = new Promise<void>((resolve) => {
			open = resolve;
		});
		const gate = gateHolder.withClientSpawnGate(() => held);
		await vi.advanceTimersByTimeAsync(20); // the timer fires; its callback queues behind the gate
		await vi.advanceTimersByTimeAsync(5);
		await service.getClientForFile("/repo/main.ts"); // a fresh use refreshes clientLastUsedAt
		open();
		await gate;
		await vi.advanceTimersByTimeAsync(1);
		expect(client.shutdown).not.toHaveBeenCalled();
		expect(service.getAliveClientCount()).toBe(1);
		await service.shutdown();
	});

	it("lease-guards the acquire/use gap while didOpen is suspended", async () => {
		vi.useFakeTimers();
		const client = fakeClient("leased");
		createLSPClient.mockResolvedValue(client);
		configureServer();
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

	it("clears idle-timer ownership on notify-backpressure eviction", async () => {
		vi.useFakeTimers();
		const client = fakeClient("backpressured");
		createLSPClient.mockResolvedValue(client);
		configureServer();
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const harness = service as unknown as {
			state: { clients: Map<string, typeof client> };
			idleEvictionTimers: Map<string, ReturnType<typeof setTimeout>>;
			recordNotifyWriteBackpressure(
				key: string,
				entry: unknown,
				filePath: string,
			): void;
		};
		const entry = await service.getClientForFile("/repo/main.ts");
		expect(entry).toBeDefined();
		expect(harness.idleEvictionTimers.size).toBe(1);
		const key = [...harness.state.clients.keys()][0];
		expect(key).toBeDefined();

		for (let attempt = 0; attempt < 3; attempt++) {
			harness.recordNotifyWriteBackpressure(
				key as string,
				entry as NonNullable<typeof entry>,
				"/repo/main.ts",
			);
		}

		expect(harness.idleEvictionTimers.size).toBe(0);
		await vi.advanceTimersByTimeAsync(20);
		expect(client.shutdown).toHaveBeenCalledTimes(1);
	});

	it("does not let a stale demotion delete a replacement generation", async () => {
		const predecessor = fakeClient("predecessor");
		const replacement = fakeClient("replacement");
		createLSPClient.mockResolvedValue(predecessor);
		configureServer();
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
		configureServer();
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
			callbackA!();
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
		configureServer();
		const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const harness = service as unknown as {
			idleEvictionTimers: Map<string, ReturnType<typeof setTimeout>>;
		};
		await service.getClientForFile("/repo/main.ts");

		const timer = [...harness.idleEvictionTimers.values()][0];
		expect(timer).toBeDefined();
		expect(timer.hasRef?.()).toBe(false);
		await service.shutdown();

		expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
		expect(harness.idleEvictionTimers.size).toBe(0);
	});
});
