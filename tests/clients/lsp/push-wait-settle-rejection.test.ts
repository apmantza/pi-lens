// flake-shape: raw-timer-wait — Node delivers `unhandledRejection` on a real macrotask; fake timers never fire it, so the guard drains one real `setImmediate` tick after the driven touch settles. The assertion is on the listener's captured list, never on elapsed time.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #2703 (oxlint `no-floating-promises`, 2026-09-07): the push-wait settle
// marker in `LSPService.touchFile` was a resolve-only `pushWait.then(...)`.
// When the with-auxiliary wait REJECTED (the aux-grace IIFE's tail threw),
// the derived promise rejected with no handler and Node raised
// `unhandledRejection` — separately from the rejection the awaiters below
// already handled. The marker now attaches on both paths. Harness: the
// trimmed `service-aux-grace.test.ts` doubles; the throw is pinned to the
// one row inside `pushWait` that can reject at all (`perServerWaits` each
// end in `.catch(() => undefined)`).

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
const logLatency = vi.fn();

vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency,
}));
vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

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

function makeServer(id: string, aux: boolean) {
	return {
		id,
		name: id,
		extensions: [".ts"],
		...(aux ? { role: "auxiliary" as const } : {}),
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({ process: makeFakeProcess(), source: "test" })),
	};
}

function makeClient(delayMs: number, serverId: string) {
	let version = 0;
	const stamps = new Map<string, number>();
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
			return version;
		},
		getDiagnosticsVersionForPath: vi.fn((p: string) => stamps.get(p) ?? 0),
		getDiagnostics: vi.fn(() => []),
		notify: {
			open: vi.fn(async () => {}),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		waitForDiagnostics: vi.fn(
			(p: string, t: number) =>
				new Promise<void>((res) =>
					setTimeout(
						() => {
							version += 1;
							stamps.set(p, version);
							res();
						},
						Math.min(delayMs, t),
					),
				),
		),
	};
}

describe("touchFile push-wait settle marker", () => {
	let seen: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		seen.push(reason);
	};

	beforeEach(() => {
		seen = [];
		process.on("unhandledRejection", onUnhandled);
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		process.env.PI_LENS_AUX_GRACE_MS = "500";
	});

	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete process.env.PI_LENS_AUX_GRACE_MS;
	});

	it("leaves no unhandled rejection when the with-auxiliary push wait rejects", async () => {
		logLatency.mockImplementation((row: { phase?: string }) => {
			if (row?.phase === "lsp_aux_wait_outcome") {
				throw new Error("PROBE: aux tail threw");
			}
		});
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const primaryClient = makeClient(100, "ts-primary");
		const auxClient = makeClient(3000, "opengrep-aux");
		getServersForFileWithConfig.mockReturnValue([
			makeServer("ts-primary", false),
			makeServer("opengrep-aux", true),
		]);
		createLSPClient
			.mockResolvedValueOnce(primaryClient)
			.mockResolvedValueOnce(auxClient);
		await service.getClientsForFile(FILE);
		createLSPClient.mockReset();

		const touch = service
			.touchFile(FILE, "content", {
				clientScope: "with-auxiliary",
				auxiliaryServerIds: ["opengrep-aux"],
				collectDiagnostics: true,
				diagnostics: "document",
			})
			.then(() => "resolved")
			.catch((e: Error) => `threw: ${e.message}`);

		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(600);
		const outcome = await touch;
		// The rejection must have happened for the guard to mean anything:
		// a resolved touch would pass vacuously.
		expect(outcome).toBe("threw: PROBE: aux tail threw");

		// Node delivers `unhandledRejection` on a real macrotask; fake timers
		// never fire it, so drain one real tick.
		vi.useRealTimers();
		await new Promise((resolve) => setImmediate(resolve));
		expect(seen.map(String)).toEqual([]);
	});
});
