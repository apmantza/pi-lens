/**
 * #743 — per-server notify-write deadlines.
 *
 * Before this fix the didOpen/didChange write for a `clientScope:"all"` touch
 * fanned out across every spawned server under a SINGLE `notifyWriteBudgetMs`
 * deadline (`Promise.all`). One backpressured server (stalled stdin) timed out
 * the write for the ENTIRE file, flipping the touch to inconclusive and zeroing
 * every co-touched healthy server's diagnostics — none reached `demonstratedReady`.
 *
 * These tests verify:
 *  1. One server timing out its write does NOT mark the others timed out, and a
 *     healthy sibling still becomes `demonstratedReady`.
 *  2. Repeated write timeouts (>= NOTIFY_BACKPRESSURE_BROKEN_AFTER = 3) trip the
 *     existing `broken` cooldown for that server and evict its client.
 *  3. A single successful write resets the consecutive-timeout streak.
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

const FILE = "C:/repo/main.ts";
const NOTIFY_BUDGET_MS = 100;

type TestServer = Omit<
	import("../../../clients/lsp/server.js").LSPServerInfo,
	"spawn"
> & { spawn: ReturnType<typeof vi.fn> };

function makeServer(id: string, ext = ".ts"): TestServer {
	return {
		id,
		name: id,
		extensions: [ext],
		idleEviction: "transparent",
		role: "language",
		root: async () => "C:/repo",
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

function makeDiagnostic(message: string) {
	return {
		severity: 1 as const,
		message,
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
	};
}

/**
 * A fake client. When `stallWrite` is true its `notify.open` returns a
 * never-resolving promise (simulating stalled stdin backpressure); otherwise it
 * resolves immediately. `waitForDiagnostics` always resolves right away so the
 * diagnostics wait itself never times out — the touch's only timeout source is
 * the notify write, which is exactly what these tests isolate.
 */
function makeClient(
	stallWrite: boolean,
	diags: ReturnType<typeof makeDiagnostic>[] = [],
) {
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
		getDiagnostics: vi.fn(() => diags),
		notify: {
			open: vi.fn(() =>
				stallWrite ? new Promise<void>(() => {}) : Promise.resolve(),
			),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		waitForDiagnostics: vi.fn(async () => undefined),
	};
}

describe("#743 — per-server notify-write deadlines", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = String(NOTIFY_BUDGET_MS);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
	});

	it("a stalled sibling write does not mark the healthy server timed out; healthy server still reaches demonstratedReady", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const stalledClient = makeClient(true, [makeDiagnostic("stalled finding")]);
		const healthyClient = makeClient(false, [
			makeDiagnostic("healthy finding"),
		]);

		const stalledServer = makeServer("stalled");
		const healthyServer = makeServer("healthy");

		getServersForFileWithConfig.mockReturnValue([stalledServer, healthyServer]);
		createLSPClient
			.mockResolvedValueOnce(stalledClient)
			.mockResolvedValueOnce(healthyClient);

		const touchPromise = service.touchFile(FILE, "content-a", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "test",
		});

		// Let the healthy write settle, then drive the stalled write past its own
		// per-server budget so its deadline (not the healthy one's) fires.
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS + 20);
		const result = await touchPromise;

		expect(Array.isArray(result?.diags)).toBe(true);

		// Both writes were attempted.
		expect(stalledClient.notify.open).toHaveBeenCalledTimes(1);
		expect(healthyClient.notify.open).toHaveBeenCalledTimes(1);

		// The healthy server is marked demonstratedReady; the stalled one is not.
		const ready = [
			...(
				service as unknown as {
					state: { demonstratedReady: Set<string> };
				}
			).state.demonstratedReady,
		];
		expect(ready.some((k) => k.startsWith("healthy:"))).toBe(true);
		expect(ready.some((k) => k.startsWith("stalled:"))).toBe(false);

		// The stalled server did not get demoted after a single timeout.
		const broken = (
			service as unknown as {
				state: { broken: Map<string, number> };
			}
		).state.broken;
		expect([...broken.keys()].some((k) => k.startsWith("stalled:"))).toBe(
			false,
		);
	});

	it("repeated write timeouts trip the broken cooldown and evict the client", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const stalledClient = makeClient(true);
		const stalledServer = makeServer("wedged");

		getServersForFileWithConfig.mockReturnValue([stalledServer]);
		// Only spawned once — reused warm on the following touches until eviction.
		createLSPClient.mockResolvedValue(stalledClient);

		const brokenMap = (
			service as unknown as {
				state: { broken: Map<string, number> };
			}
		).state.broken;

		// Three consecutive timing-out writes (distinct content so the notify is
		// never debounced/skipped) — the third hits NOTIFY_BACKPRESSURE_BROKEN_AFTER.
		for (let i = 0; i < 3; i++) {
			const p = service.touchFile(FILE, `content-${i}`, {
				clientScope: "all",
				diagnostics: "document",
				collectDiagnostics: true,
				source: "test",
			});
			await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS + 20);
			await p;
			if (i < 2) {
				// Not yet demoted before the threshold.
				expect([...brokenMap.keys()].some((k) => k.startsWith("wedged:"))).toBe(
					false,
				);
			}
		}

		// Demoted via the existing broken map, and the wedged client was evicted.
		expect([...brokenMap.keys()].some((k) => k.startsWith("wedged:"))).toBe(
			true,
		);
		expect(stalledClient.shutdown).toHaveBeenCalled();
		const clients = (
			service as unknown as {
				state: { clients: Map<string, unknown> };
			}
		).state.clients;
		expect([...clients.keys()].some((k) => k.startsWith("wedged:"))).toBe(
			false,
		);
	});

	it("a successful write resets the consecutive-timeout streak so demotion needs a fresh run", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// A client we can flip between stalling and healthy between touches.
		let stall = true;
		const client = {
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
				open: vi.fn(() =>
					stall ? new Promise<void>(() => {}) : Promise.resolve(),
				),
				change: vi.fn(async () => {}),
				close: vi.fn(async () => {}),
			},
			waitForDiagnostics: vi.fn(async () => undefined),
		};
		const server = makeServer("flaky");
		getServersForFileWithConfig.mockReturnValue([server]);
		createLSPClient.mockResolvedValue(client);

		const brokenMap = (
			service as unknown as {
				state: { broken: Map<string, number> };
			}
		).state.broken;

		const runTouch = async (content: string) => {
			const p = service.touchFile(FILE, content, {
				clientScope: "all",
				diagnostics: "document",
				collectDiagnostics: true,
				source: "test",
			});
			await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS + 20);
			await p;
		};

		// Two timeouts, then a clean write (resets streak), then two more timeouts.
		// Without a reset that would be 4 consecutive timeouts (>= 3 → demoted);
		// with the reset it is at most 2 in a row, so NO demotion.
		await runTouch("c0"); // timeout (streak 1)
		await runTouch("c1"); // timeout (streak 2)
		stall = false;
		await runTouch("c2"); // success → streak reset
		stall = true;
		await runTouch("c3"); // timeout (streak 1)
		await runTouch("c4"); // timeout (streak 2)

		expect([...brokenMap.keys()].some((k) => k.startsWith("flaky:"))).toBe(
			false,
		);
	});

	/**
	 * #743 + #1253: the touch debounce is keyed PER SERVER.
	 *
	 * #1253 stopped a failed notify write from being recorded as delivered — a
	 * server that never received the file must be re-pushed rather than debounced
	 * into a later touch that looks fully delivered (which the silent-clean gates
	 * would read as a confirmed clean). But the recent-touches key was
	 * "file:clientScope" with no server component, so withholding the entry
	 * withheld it from every co-touched server: one wedged auxiliary disabled the
	 * debounce for its HEALTHY siblings too, re-pushing them on the next touch and
	 * clearing diagnostics they had already computed — the exact per-file collapse
	 * #743 removed from the write deadline.
	 *
	 * Per-server keying satisfies both: the stalled server has no entry and is
	 * re-pushed; the healthy server keeps its own and is skipped.
	 */
	it("a stalled sibling does not cost the healthy server its touch debounce", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const stalledClient = makeClient(true);
		const healthyClient = makeClient(false);

		getServersForFileWithConfig.mockReturnValue([
			makeServer("stalled"),
			makeServer("healthy"),
		]);
		createLSPClient
			.mockResolvedValueOnce(stalledClient)
			.mockResolvedValueOnce(healthyClient);

		const runTouch = async () => {
			const p = service.touchFile(FILE, "same-content", {
				clientScope: "all",
				diagnostics: "document",
				collectDiagnostics: true,
				source: "test",
			});
			await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS + 20);
			await p;
		};

		await runTouch();
		expect(stalledClient.notify.open).toHaveBeenCalledTimes(1);
		expect(healthyClient.notify.open).toHaveBeenCalledTimes(1);

		// Second touch, same content, well inside the 1500ms debounce window.
		await runTouch();

		// The stalled server never got the content — re-push it (#1253).
		expect(stalledClient.notify.open).toHaveBeenCalledTimes(2);
		// The healthy server already has it — its debounce must survive its
		// sibling's failure (#743). A file-level key would re-push it here.
		expect(healthyClient.notify.open).toHaveBeenCalledTimes(1);
	});
});

/**
 * #3537: the consecutive-timeout streak belongs to one client generation.
 *
 * Recurrence this block prevents: the streak was keyed by server key and
 * cleared only on a demotion or a landed write, so a client retired by a
 * crash-respawn or an eviction handed its strikes to the replacement, which
 * was then demoted on its FIRST timeout (still cold, say) and lost its
 * diagnostics for a cooldown. `forgetReadiness`, which every retirement path
 * and every registration already calls (#3502), now forgets the streak too.
 * The last case is the ordering that reset cannot reach: a predecessor's
 * write timeout that settles after the replacement registered.
 */
describe("#3537 — the notify-write streak does not outlive its client", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = String(NOTIFY_BUDGET_MS);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
		delete process.env.PI_LENS_LSP_CLIENT_CEILING;
		delete process.env.PI_LENS_TS_IDLE_EVICT_MS;
	});

	/** A stalling client that can die the way a crashed server does. */
	function makeMortalClient(stallWrite = true) {
		let alive = true;
		let exitedAt: number | undefined;
		return Object.assign(makeClient(stallWrite), {
			isAlive: () => alive,
			wasShutdownIntentional: () => false,
			getExitedAt: () => exitedAt,
			kill: () => {
				alive = false;
				exitedAt ??= Date.now();
			},
		});
	}

	async function start(servers: ReturnType<typeof makeServer>[]) {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			servers.filter((server) =>
				server.extensions.some((ext) => fp.endsWith(ext)),
			),
		);
		const touch = (filePath: string, content: string) =>
			service.touchFile(filePath, content, {
				clientScope: "all",
				diagnostics: "document",
				collectDiagnostics: true,
				source: "test",
			});
		const timedOut = async (filePath: string, content: string) => {
			const p = touch(filePath, content);
			await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS + 20);
			await p;
		};
		const demoted = (id: string) =>
			[
				...(
					service as unknown as { state: { broken: Map<string, number> } }
				).state.broken.keys(),
			].some((key) => key.startsWith(`${id}:`));
		return { service, touch, timedOut, demoted };
	}

	it("a crash-respawned replacement is not demoted on its first write timeout", async () => {
		const { timedOut, demoted } = await start([makeServer("wedged")]);
		const A = makeMortalClient();
		const B = makeMortalClient();
		createLSPClient.mockResolvedValueOnce(A).mockResolvedValueOnce(B);

		await timedOut(FILE, "c0");
		await timedOut(FILE, "c1");
		// A served for over a minute, so its death respawns at once, no breaker.
		vi.setSystemTime(Date.now() + 61_000);
		A.kill();
		await timedOut(FILE, "c2");

		expect(createLSPClient).toHaveBeenCalledTimes(2);
		expect(B.notify.open).toHaveBeenCalledTimes(1);
		expect(demoted("wedged")).toBe(false);
		expect(B.shutdown).not.toHaveBeenCalled();
	});

	it("a replacement after a capacity eviction is not demoted on its first write timeout", async () => {
		process.env.PI_LENS_LSP_CLIENT_CEILING = "1";
		const { timedOut, demoted } = await start([
			makeServer("wedged"),
			makeServer("lua", ".lua"),
		]);
		const A = makeMortalClient();
		const L = makeMortalClient(false);
		const B = makeMortalClient();
		createLSPClient
			.mockResolvedValueOnce(A)
			.mockResolvedValueOnce(L)
			.mockResolvedValueOnce(B);

		await timedOut(FILE, "c0");
		await timedOut(FILE, "c1");
		await timedOut("C:/repo/x.lua", "local x = 1");
		expect(A.shutdown).toHaveBeenCalledTimes(1);
		await timedOut(FILE, "c2");

		expect(createLSPClient).toHaveBeenCalledTimes(3);
		expect(B.notify.open).toHaveBeenCalledTimes(1);
		expect(demoted("wedged")).toBe(false);
		expect(B.shutdown).not.toHaveBeenCalled();
	});

	it("a replacement after a TypeScript idle eviction is not demoted on its first write timeout", async () => {
		process.env.PI_LENS_TS_IDLE_EVICT_MS = "1000";
		const { timedOut, demoted } = await start([makeServer("typescript")]);
		const A = makeMortalClient();
		const B = makeMortalClient();
		createLSPClient.mockResolvedValueOnce(A).mockResolvedValueOnce(B);

		await timedOut(FILE, "c0");
		await timedOut(FILE, "c1");
		await vi.advanceTimersByTimeAsync(1_100);
		expect(A.shutdown).toHaveBeenCalledTimes(1);
		await timedOut(FILE, "c2");

		expect(createLSPClient).toHaveBeenCalledTimes(2);
		expect(B.notify.open).toHaveBeenCalledTimes(1);
		expect(demoted("typescript")).toBe(false);
		expect(B.shutdown).not.toHaveBeenCalled();
	});

	it("a predecessor's write timeout that settles after the replacement registered does not strike it", async () => {
		const { touch, timedOut, demoted } = await start([makeServer("wedged")]);
		const A = makeMortalClient();
		const B = makeMortalClient();
		createLSPClient.mockResolvedValueOnce(A).mockResolvedValueOnce(B);

		// A's write is outstanding when A dies and B is spawned for another file.
		const late = touch(FILE, "c0");
		await vi.advanceTimersByTimeAsync(10);
		vi.setSystemTime(Date.now() + 61_000);
		A.kill();
		const first = touch("C:/repo/other.ts", "d0");
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS + 20);
		await Promise.all([late, first]);
		expect(createLSPClient).toHaveBeenCalledTimes(2);
		await timedOut(FILE, "c1");

		// B has timed out twice, not the three times demotion needs.
		expect(B.notify.open).toHaveBeenCalledTimes(2);
		expect(demoted("wedged")).toBe(false);
		expect(B.shutdown).not.toHaveBeenCalled();
	});
});
