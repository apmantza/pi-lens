/**
 * #2358 — the notify-stall breaker must not kill a BUSY server. These tests run
 * a REAL auxiliary LSP child over real stdio and real process CPU sampling; the
 * adaptive-budget half (client doubles, fake timers) lives in
 * `service-notify-adaptive-budget.test.ts`.
 *
 * The fixture pauses its stdin after the initialize handshake, so the touch's
 * next `didOpen` (deliberately ~1 MB, bigger than any OS pipe buffer) stays
 * OUTSTANDING — the exact shape that armed the old fixed-window breaker. With
 * `FAKE_LSP_BURN_CPU_AFTER_INIT` it burns one core forever ("dead but
 * spinning"); without it, it idles (genuinely flat).
 *
 * Pre-#2358 both shapes were torn down at the fixed 10 s window (500 x budget
 * here). Post-fix: the busy one survives — the CPU discriminator defers and the
 * timer re-arms — and the flat one is torn down, with the record naming
 * `budget-exceeded-cpu-flat` (or `cap-exceeded` at the hard cap).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import type { LSPProcess } from "../../../clients/lsp/launch.js";

const getServersForFileWithConfig = vi.fn();

vi.hoisted(() => {
	// This suite checks the same NDJSON bytes production consumes. Keep the
	// opt-out scoped to this worker; ordinary suites remain in test mode.
	process.env.PI_LENS_TEST_MODE = "0";
});

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER_PATH = path.join(
	__dirname,
	"../../fixtures/fake-lsp-server.mjs",
);
const ROOT = process.cwd();
const NOTIFY_BUDGET_MS = 200;
/** `notifyWedgedMs` = budget x 5 = 1000 at this budget. */
const FIXED_WEDGE_MS = NOTIFY_BUDGET_MS * 5;
/** Bigger than any OS pipe buffer, so the write cannot settle into it. */
const BIG_CONTENT = "export const wedge = 1;\n".repeat(60_000);
const AUX_CLIENT_KEY = `opengrep:${normalizeMapKey(ROOT)}`;

const CPU_SAMPLE_MS = 300;

let latencyLogger:
	| typeof import("../../../clients/latency-logger.js")
	| undefined;

function rowsFor(phase: string): Array<Record<string, unknown>> {
	const file = latencyLogger?.getLatencyLogPath();
	if (!file || !fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((entry) => entry.phase === phase);
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs: number,
	message: string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return;
		if (Date.now() >= deadline) {
			throw new Error(message);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

async function assertChildExited(handle: LSPProcess): Promise<void> {
	if (handle.process.exitCode !== null || handle.process.signalCode !== null) {
		return;
	}
	await new Promise<void>((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const done = (): void => {
			if (timer !== undefined) clearTimeout(timer);
			handle.process.off?.("exit", done);
			resolve();
		};
		handle.process.once?.("exit", done);
		timer = setTimeout(done, 3_000);
	});
	expect(
		handle.process.exitCode !== null || handle.process.signalCode !== null,
	).toBe(true);
}

describe("#2358 — CPU-liveness discriminator on a real wedged scanner", () => {
	type ServiceLike = {
		touchFile: (...args: never[]) => Promise<unknown>;
		shutdown: (o?: { reason?: string; fast?: boolean }) => Promise<void>;
		state: {
			clients: Map<string, unknown>;
			broken: Map<string, number>;
		};
	};
	let service: ServiceLike | undefined;
	let childHandles: LSPProcess[] = [];

	async function makeAuxServer(burnCpu: boolean) {
		return {
			id: "opengrep",
			name: "opengrep",
			role: "auxiliary" as const,
			extensions: [".ts"],
			root: async () => ROOT,
			spawn: async () => {
				const { launchLSP } = await import("../../../clients/lsp/launch.js");
				const childHandle = await launchLSP(
					process.execPath,
					[FAKE_SERVER_PATH],
					{
						cwd: ROOT,
						env: {
							...process.env,
							FAKE_LSP_WEDGE_STDIN_AFTER_INIT: "1",
							...(burnCpu ? { FAKE_LSP_BURN_CPU_AFTER_INIT: "1" } : {}),
						},
					},
				);
				childHandles.push(childHandle);
				return { process: childHandle, source: "test" as const };
			},
		};
	}

	async function wedgeTouch(burnCpu: boolean): Promise<void> {
		latencyLogger = await import("../../../clients/latency-logger.js");
		latencyLogger.clearLatencyLog();
		await latencyLogger.flushLatencyLog();
		const { LSPService } = await import("../../../clients/lsp/index.js");
		service = new LSPService() as unknown as ServiceLike;
		getServersForFileWithConfig.mockReturnValue([await makeAuxServer(burnCpu)]);
		// The write to the paused-stdin child never settles, so the touch returns
		// on its own notify budget; the wedge timer keeps running in the service.
		await (
			service as unknown as {
				touchFile: (...args: unknown[]) => Promise<unknown>;
			}
		).touchFile(`${ROOT}/wedge-file.ts`, BIG_CONTENT, {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: false,
			source: "lens_diagnostics_full",
		});
	}

	const broken = (): boolean => {
		const keys = Array.from(service?.state.broken.keys() ?? []);
		return keys.some((k) => String(k).startsWith("opengrep:"));
	};
	const clientStillRegistered = (): boolean => {
		return service?.state.clients.has(AUX_CLIENT_KEY) ?? false;
	};

	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = String(NOTIFY_BUDGET_MS);
		process.env.PI_LENS_LSP_NOTIFY_STALL_CPU_SAMPLE_MS = String(CPU_SAMPLE_MS);
	});

	afterEach(async () => {
		if (latencyLogger) await latencyLogger.flushLatencyLog();
		if (service) {
			try {
				await service.shutdown({ reason: "test", fast: true });
			} catch {
				// best-effort teardown
			}
		}
		const handles = childHandles;
		childHandles = [];
		service = undefined;
		expect(handles.length).toBeGreaterThan(0);
		const { killProcessTree } = await import("../../../clients/lsp/client.js");
		for (const handle of handles) {
			try {
				// Track and reap every child. A touch can retry acquisition after a
				// generation change, so one "last handle" is insufficient and leaks
				// every earlier detached fixture into the worker's inherited pipes.
				// Await the tree-kill command here. The production fast path is
				// intentionally fire-and-forget, but a test worker must not exit while
				// its detached cleanup command is still queued.
				await killProcessTree(handle.process, handle.pid);
				handle.process.kill();
			} catch {
				// already exited
			}
			await assertChildExited(handle);
		}
		delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
		delete process.env.PI_LENS_LSP_NOTIFY_STALL_CPU_SAMPLE_MS;
		delete process.env.PI_LENS_LSP_NOTIFY_WEDGED_CAP_MS;
		latencyLogger = undefined;
		vi.restoreAllMocks();
	});

	it("leaves a stop-reading server alone while its CPU is burning (AC1)", async () => {
		await wedgeTouch(true);

		// Wait far past the fixed 10 s-equivalent window (1000 ms here) plus a
		// couple of re-arm cycles. A pre-#2358 breaker demoted the moment the
		// fixed window elapsed; this one must defer while the process burns.
		await waitFor(
			async () => {
				await latencyLogger?.flushLatencyLog();
				return rowsFor("lsp_notify_stall_cpu_busy").length >= 1;
			},
			FIXED_WEDGE_MS * 3 + 2_000,
			"the CPU discriminator never recorded a busy defer",
		);
		// Give the first deferred cycle's re-arm a moment to prove the timer
		// kept running without demoting.
		await new Promise((resolve) => setTimeout(resolve, FIXED_WEDGE_MS + 800));

		expect(broken()).toBe(false);
		expect(clientStillRegistered()).toBe(true);
		// The adaptive timer re-arms while busy, but detail telemetry remains
		// rising-edge bounded for this server/file identity.
		expect(rowsFor("lsp_notify_stall_cpu_busy")).toHaveLength(1);
		expect(rowsFor("lsp_notify_backpressure_broken")).toHaveLength(0);
	}, 30_000);

	it("tears down a stop-reading server whose CPU is flat, naming the discriminator (AC2/AC3)", async () => {
		await wedgeTouch(false);

		await waitFor(
			broken,
			FIXED_WEDGE_MS * 3 + 4_000,
			"the flat-CPU server was never torn down within the adaptive budget",
		);
		await latencyLogger?.flushLatencyLog();
		expect(clientStillRegistered()).toBe(false);

		const demotions = rowsFor("lsp_notify_backpressure_broken");
		expect(demotions).toHaveLength(1);
		expect(demotions[0]?.metadata).toMatchObject({
			serverId: "opengrep",
			discriminator: "budget-exceeded-cpu-flat",
			cpuVerdict: "flat",
			budgetMs: FIXED_WEDGE_MS,
		});
		const outstandingMs = (
			demotions[0]?.metadata as { outstandingMs?: number } | undefined
		)?.outstandingMs;
		// `outstandingMs` is sampled with Date.now() when the wedge timer fires.
		// Windows and Node can quantize the timer and wall clock on adjacent
		// millisecond boundaries, so allow a two-millisecond lower-bound margin.
		expect(outstandingMs).toBeGreaterThanOrEqual(FIXED_WEDGE_MS - 2);
	}, 30_000);

	it("applies the hard cap even to a burning server, naming cap-exceeded (AC3)", async () => {
		process.env.PI_LENS_LSP_NOTIFY_WEDGED_CAP_MS = "2500";
		await wedgeTouch(true);

		await waitFor(
			broken,
			FIXED_WEDGE_MS * 6 + 4_000,
			"the busy server was never capped out",
		);
		await latencyLogger?.flushLatencyLog();
		const demotions = rowsFor("lsp_notify_backpressure_broken");
		expect(demotions).toHaveLength(1);
		expect(demotions[0]?.metadata).toMatchObject({
			serverId: "opengrep",
			discriminator: "cap-exceeded",
		});
	}, 30_000);
});
