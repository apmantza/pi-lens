/**
 * #2358 — the notify-stall breaker's teardown decision gained two guards, and
 * this file pins the ADAPTIVE half against client doubles where the clock is
 * the host's to move.
 *
 * Pre-#2358 the wedge timer killed a server whose auxiliary notify write stayed
 * outstanding for a FIXED window (`notifyWedgedMs` = budget x 5), conflating a
 * dead input path with a busy scanner draining a burst — the live opengrep
 * kill at #2358's head. The window is now
 * `max(fixed floor, k x EWMA per-write latency x unacked depth)`, capped, and a
 * write that lands inside it RETRACTS the timeout it was charged for. The CPU
 * side (real processes, real sampling) lives in
 * `service-notify-cpu-liveness.test.ts`; the doubles here model no process, so
 * the breaker keeps the pre-#2358 demote-at-budget behavior after the adaptive
 * window elapses — exactly what lets these tests assert the window without a
 * 60-second wait.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMapKey } from "../../../clients/path-utils.js";

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

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

const ROOT = "C:/repo";
const NOTIFY_BUDGET_MS = 100;
/** `notifyWedgedMs` = budget x 5 = 500 at this budget. */
const FIXED_WEDGE_MS = NOTIFY_BUDGET_MS * 5;
const AUX_KEY = `ast-grep:${normalizeMapKey(ROOT)}`;

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

function makeServer(
	id: string,
	role?: "auxiliary",
	extra: Record<string, unknown> = {},
) {
	return {
		id,
		name: id,
		extensions: [".ts"],
		...(role !== undefined && { role }),
		...extra,
		root: async () => ROOT,
		spawn: vi.fn(async () => ({ process: makeFakeProcess(), source: "test" })),
	};
}

/**
 * A scanner double whose write wire settles `writeDelayMs` after issue (or
 * never when `writeLands: false`), whose liveness round-trip can be turned off,
 * and which deliberately exposes NO process pid — so the CPU discriminator
 * reports "unmeasured" and the demote-at-budget path stays deterministic.
 */
function makeScanner(
	serverId: string,
	options: {
		writeLands?: boolean;
		writeDelayMs?: number;
		pingAnswers?: boolean;
	} = {},
) {
	const writeLands = options.writeLands ?? true;
	const writeDelayMs = options.writeDelayMs ?? 0;
	const pingAnswers = options.pingAnswers ?? true;
	const stats = { opens: 0, pings: 0 };
	let version = 0;
	const stampsByPath = new Map<string, number>();
	return {
		stats,
		serverId,
		isAlive: () => true,
		shutdown: vi.fn(async () => {}),
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		get diagnosticsVersion() {
			return version;
		},
		getDiagnosticsVersionForPath: vi.fn(
			(filePath: string) => stampsByPath.get(filePath) ?? 0,
		),
		getDiagnostics: vi.fn(() => []),
		pingLiveness: vi.fn(async () => {
			stats.pings += 1;
			return pingAnswers;
		}),
		notify: {
			open: vi.fn(async () => {
				stats.opens += 1;
				if (!writeLands) return new Promise<void>(() => {});
				if (writeDelayMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, writeDelayMs));
				}
			}),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		waitForDiagnostics: vi.fn(
			(filePath: string) =>
				new Promise<void>((resolve) => {
					version += 1;
					stampsByPath.set(filePath, version);
					resolve();
				}),
		),
	};
}

function makePrimary(serverId: string) {
	let version = 0;
	const stampsByPath = new Map<string, number>();
	return {
		serverId,
		isAlive: () => true,
		shutdown: vi.fn(async () => {}),
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		get diagnosticsVersion() {
			return version;
		},
		getDiagnosticsVersionForPath: vi.fn(
			(filePath: string) => stampsByPath.get(filePath) ?? 0,
		),
		getDiagnostics: vi.fn(() => []),
		pingLiveness: vi.fn(async () => true),
		notify: {
			open: vi.fn(async () => {}),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		waitForDiagnostics: vi.fn(
			(filePath: string) =>
				new Promise<void>((resolve) => {
					version += 1;
					stampsByPath.set(filePath, version);
					resolve();
				}),
		),
	};
}

function brokenKeys(service: unknown): string[] {
	return [
		...(
			service as { state: { broken: Map<string, number> } }
		).state.broken.keys(),
	];
}

function rowsFor(phase: string): Array<Record<string, unknown>> {
	return logLatency.mock.calls
		.map(([entry]) => entry)
		.filter((entry) => entry?.phase === phase);
}

async function makeService() {
	const { LSPService } = await import("../../../clients/lsp/index.js");
	return new LSPService();
}

type RawService = {
	auxNotifyInflight: Map<
		string,
		{ client: unknown; unacked: number; gateOpen?: boolean }
	>;
	auxNotifyDrainLatencyEwma: Map<string, number>;
};

function rawService(service: unknown): RawService {
	return service as unknown as RawService;
}

describe("#2358 — adaptive wedge window pricing", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = String(NOTIFY_BUDGET_MS);
		delete process.env.PI_LENS_LSP_NOTIFY_WEDGED_CAP_MS;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
		delete process.env.PI_LENS_LSP_NOTIFY_WEDGED_CAP_MS;
		delete process.env.PI_LENS_LSP_NOTIFY_STALL_CPU_SAMPLE_MS;
	});

	/**
	 * Drive ONE touch through `touchFile` and advance the fake clock far enough
	 * for the touch itself to settle (its write times out at the notify budget;
	 * `collectDiagnostics: false` keeps the touch from parking on diagnostic
	 * waits the double cannot satisfy). Returns after the touch resolved.
	 */
	async function settleTouch(
		service: unknown,
		aux: unknown,
		advanceMs: number,
	): Promise<void> {
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("ast-grep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "ast-grep" ? aux : makePrimary("typescript"),
		);
		const pending = (
			service as { touchFile: (...args: unknown[]) => Promise<unknown> }
		).touchFile(`${ROOT}/file0.ts`, `content of file0`, {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: false,
			source: "lens_diagnostics_full",
		});
		await vi.advanceTimersByTimeAsync(advanceMs);
		await pending;
	}

	it("defers the wedge demotion past the fixed floor when drain history says the server is slow", async () => {
		// #2358's evidence shape: historically ~850 ms per answer, 8 writes
		// queued. The adaptive window is max(500ms floor, 2 x 850 x 8) = 13 600 ms.
		const EWMA_MS = 850;
		const DEPTH = 8;
		const ADAPTIVE_BUDGET_MS = 2 * EWMA_MS * DEPTH; // 13 600
		const aux = makeScanner("ast-grep", {
			writeLands: false,
			pingAnswers: false,
		});
		const service = await makeService();
		const raw = rawService(service);
		raw.auxNotifyInflight.set(AUX_KEY, { client: aux, unacked: DEPTH });
		raw.auxNotifyDrainLatencyEwma.set(AUX_KEY, EWMA_MS);

		await settleTouch(service, aux, FIXED_WEDGE_MS);

		// A slow-but-alive server must NOT be torn down at the fixed window:
		// the wedge timer is armed with 13 600 ms, not 500.
		expect(brokenKeys(service).some((k) => k.startsWith("ast-grep:"))).toBe(
			false,
		);
		expect(aux.shutdown).not.toHaveBeenCalled();
		expect(rowsFor("lsp_notify_backpressure_broken")).toHaveLength(0);

		// Only the ADAPTIVE window's expiry tears it down, and the record names
		// every input so a production kill is classifiable.
		await vi.advanceTimersByTimeAsync(ADAPTIVE_BUDGET_MS * 2);
		expect(brokenKeys(service).some((k) => k.startsWith("ast-grep:"))).toBe(
			true,
		);
		expect(aux.shutdown).toHaveBeenCalled();
		const demotions = rowsFor("lsp_notify_backpressure_broken");
		expect(demotions).toHaveLength(1);
		expect(demotions[0]?.metadata).toMatchObject({
			serverId: "ast-grep",
			discriminator: "budget-exceeded",
			budgetMs: ADAPTIVE_BUDGET_MS,
			ewmaInputMs: EWMA_MS,
			// The seeded 8 depth plus the wedging write itself.
			unackedDepth: DEPTH + 1,
			cpuVerdict: "unmeasured",
		});
	}, 30_000);

	it("a write landing inside the adaptive window retracts the strike it was charged", async () => {
		// The retraction ceiling (#743's strike ladder) must match the wedge
		// timer's window: a write that lands at 700 ms — past the 500 ms FIXED
		// wedge, but well inside the 13.6 s adaptive window — is a slow scan,
		// not a stall; it retracts instead of accruing a demotion charge.
		const EWMA_MS = 850;
		const DEPTH = 8;
		const aux = makeScanner("ast-grep", {
			writeLands: true,
			writeDelayMs: 700,
			pingAnswers: false,
		});
		const service = await makeService();
		const raw = rawService(service);
		raw.auxNotifyInflight.set(AUX_KEY, { client: aux, unacked: DEPTH });
		raw.auxNotifyDrainLatencyEwma.set(AUX_KEY, EWMA_MS);

		await settleTouch(service, aux, 1200);

		const late = rowsFor("lsp_notify_write_late_landed");
		expect(late, "expected a retraction, saw none").toHaveLength(1);
		expect(late[0]?.metadata).toMatchObject({
			serverId: "ast-grep",
			outstandingMs: 700,
			streakAfter: 0,
		});
		// The write landed, so no teardown followed the retraction.
		expect(brokenKeys(service).some((k) => k.startsWith("ast-grep:"))).toBe(
			false,
		);
		expect(rowsFor("lsp_notify_backpressure_broken")).toHaveLength(0);
	}, 30_000);

	it("folds a drained barrier's per-write latency into the EWMA", async () => {
		const service = await makeService();
		const raw = rawService(service);
		const note = (durationMs: number, outstanding: number): void => {
			(
				service as unknown as {
					noteAuxNotifyDrainLatency: (k: string, d: number, o: number) => void;
				}
			).noteAuxNotifyDrainLatency(AUX_KEY, durationMs, outstanding);
		};
		// 1600 ms to drain 2 writes = 800 ms per write.
		note(1600, 2);
		// 3000 ms to drain 3 = 1000 ms per write; EWMA(0.5) => 0.5*800 + 0.5*1000.
		note(3000, 3);
		expect(raw.auxNotifyDrainLatencyEwma.get(AUX_KEY)).toBe(900);
	});

	it("does not price a replacement from a retired barrier", async () => {
		const service = await makeService();
		const raw = rawService(service);
		const predecessor = { client: {}, unacked: 2 };
		const replacement = { client: {}, unacked: 1 };
		raw.auxNotifyInflight.set(AUX_KEY, predecessor);
		const note = (record: { client: unknown; unacked: number }): void => {
			(
				service as unknown as {
					noteAuxNotifyDrainLatency: (
						k: string,
						d: number,
						o: number,
						r?: { client: unknown },
					) => void;
				}
			).noteAuxNotifyDrainLatency(AUX_KEY, 1000, 1, record);
		};
		raw.auxNotifyInflight.set(AUX_KEY, replacement);
		note(predecessor);
		expect(raw.auxNotifyDrainLatencyEwma.has(AUX_KEY)).toBe(false);
		note(replacement);
		expect(raw.auxNotifyDrainLatencyEwma.get(AUX_KEY)).toBe(1000);
	});

	it("clears the EWMA on service reset so a new session is not priced by the old one", async () => {
		const aux = makeScanner("ast-grep", {
			writeLands: false,
			pingAnswers: false,
		});
		const service = await makeService();
		rawService(service).auxNotifyDrainLatencyEwma.set(AUX_KEY, 999);
		await settleTouch(service, aux, FIXED_WEDGE_MS);

		await (
			service as unknown as { shutdown: (o?: unknown) => Promise<void> }
		).shutdown({ reason: "session_start" });

		expect(rawService(service).auxNotifyDrainLatencyEwma.size).toBe(0);
	});
});
