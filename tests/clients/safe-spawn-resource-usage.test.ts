/**
 * #620 — `safeSpawnAsync` brackets every spawn with a CPU/RSS poll
 * (`startSpawnUsageSampler`, started right after `spawn()`, stopped in the
 * "close"/"error" handlers) and logs the resulting peak/average usage into
 * the existing per-runner latency.log phase entries.
 *
 * The sampling internals (peak/average math, descendant-pid BFS, pidusage
 * batching) are unit-tested in isolation in
 * tests/clients/resource-sampler.test.ts. This file tests the WIRING only:
 * that safeSpawnAsync starts the sampler at the right moment, stops it
 * exactly once per spawn, surfaces `resourceUsage` on the resolved
 * `SpawnResult`, and logs it — via a fully mocked resource-sampler (so this
 * test never touches real pidusage/process tables) while still exercising a
 * real, tiny `node -e` child process end to end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stopMock = vi.fn();
const startSpawnUsageSamplerMock = vi.fn(
	(
		_pid: number | undefined,
		_intervalMs?: number,
		_lifetimeCapMs?: number,
	) => ({
		stop: stopMock,
	}),
);
vi.mock("../../clients/resource-sampler.js", () => ({
	startSpawnUsageSampler: (
		pid: number | undefined,
		intervalMs?: number,
		lifetimeCapMs?: number,
	) => startSpawnUsageSamplerMock(pid, intervalMs, lifetimeCapMs),
}));

const logLatencyMock = vi.fn();
vi.mock("../../clients/latency-logger.js", () => ({
	logLatency: (...args: unknown[]) => logLatencyMock(...args),
}));

const { safeSpawnAsync } = await import("../../clients/safe-spawn.js");

const NODE = process.execPath;
const EXIT_OK = ["-e", "process.exit(0)"];

describe("safeSpawnAsync resource-usage bracketing (#620)", () => {
	beforeEach(() => {
		startSpawnUsageSamplerMock.mockClear();
		stopMock.mockReset();
		logLatencyMock.mockClear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("starts the sampler right after spawn, with the child's pid and a cap from THIS spawn's deadline (#2968)", async () => {
		// #2968 recurrence: the sampler's only stop was the child's own settle,
		// so a child that never exits (a hung `.cmd` shim that survives
		// `taskkill /F /T`) polled for hours — 234 live powershell/taskkill
		// processes in the report. The polling bound has to come from the
		// deadline safe-spawn actually computed for THIS spawn, not from a
		// constant that knows nothing about the caller's timeout.
		//
		// The cap assertion rides on this spawn rather than its own: every real
		// child in this file is one more `real-process-spawn` hit against
		// tests/support/flake-shape-baseline.json, and a fix does not widen that
		// baseline for a test it wrote.
		stopMock.mockReturnValue(null);
		const result = await safeSpawnAsync(NODE, EXIT_OK, { timeout: 12_000 });

		expect(startSpawnUsageSamplerMock).toHaveBeenCalledTimes(1);
		const [pidArg, intervalMsArg, lifetimeCapMsArg] =
			startSpawnUsageSamplerMock.mock.calls[0];
		expect(typeof pidArg).toBe("number");
		// The cadence stays the sampler's own default; only the deadline is
		// safe-spawn's to supply.
		expect(intervalMsArg).toBeUndefined();
		// 12s timeout + the 5s teardown grace (SIGTERM, its 1s SIGKILL
		// escalation, then at most 2s of pipe-idle wait).
		expect(lifetimeCapMsArg).toBe(17_000);
		expect(result.status).toBe(0);
	});

	it("stops the sampler exactly once and attaches resourceUsage when a summary landed", async () => {
		const summary = {
			sampleCount: 3,
			avgCpuPercent: 15,
			peakCpuPercent: 40,
			avgRssBytes: 1e7,
			peakRssBytes: 2e7,
		};
		stopMock.mockReturnValue(summary);

		const result = await safeSpawnAsync(NODE, EXIT_OK);

		expect(stopMock).toHaveBeenCalledTimes(1);
		expect(result.resourceUsage).toEqual(summary);
	});

	it("leaves resourceUsage undefined (never a fabricated reading) when the sampler got zero samples", async () => {
		stopMock.mockReturnValue(null);

		const result = await safeSpawnAsync(NODE, EXIT_OK);

		expect(result.resourceUsage).toBeUndefined();
	});

	it("logs a spawn_resource_usage phase entry with the command + summary when a sample landed", async () => {
		const summary = {
			sampleCount: 1,
			avgCpuPercent: 5,
			peakCpuPercent: 5,
			avgRssBytes: 1000,
			peakRssBytes: 1000,
		};
		stopMock.mockReturnValue(summary);

		await safeSpawnAsync(NODE, EXIT_OK, { resourceLabel: "fake-runner" });

		expect(logLatencyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "phase",
				phase: "spawn_resource_usage",
				metadata: expect.objectContaining({
					command: "fake-runner",
					...summary,
				}),
			}),
		);
	});

	it("does not log a resource-usage phase entry when no sample ever landed", async () => {
		stopMock.mockReturnValue(null);

		await safeSpawnAsync(NODE, EXIT_OK);

		expect(logLatencyMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ phase: "spawn_resource_usage" }),
		);
	});

	it("resourceLabel defaults to the bare command name when not supplied", async () => {
		stopMock.mockReturnValue({
			sampleCount: 1,
			avgCpuPercent: 1,
			peakCpuPercent: 1,
			avgRssBytes: 1,
			peakRssBytes: 1,
		});

		await safeSpawnAsync(NODE, EXIT_OK);

		expect(logLatencyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({ command: NODE }),
			}),
		);
	});

	it("resolves cleanly for a non-existent command without ever starting the sampler", async () => {
		stopMock.mockReturnValue(null);
		const result = await safeSpawnAsync("this-command-does-not-exist-620", []);

		// #817: on Windows, command resolution (PATH+PATHEXT walk) now happens
		// BEFORE any process is spawned. An unresolvable command short-circuits
		// straight to an ENOENT-shaped SpawnResult.error — no child process ever
		// exists, so there is nothing for the CPU/RSS sampler to bracket; it
		// must not be started (and therefore never stopped) at all. On POSIX,
		// shell:false spawn fails to exec and surfaces via the "error" event,
		// which DOES start-then-stop the sampler around the failed attempt —
		// this assertion is Windows-specific behavior.
		if (process.platform === "win32") {
			expect(startSpawnUsageSamplerMock).not.toHaveBeenCalled();
			expect(stopMock).not.toHaveBeenCalled();
		} else {
			expect(stopMock).toHaveBeenCalledTimes(1);
		}
		expect(result.status !== 0 || result.error !== undefined).toBe(true);
	});

	it("a throwing startSpawnUsageSampler never breaks the spawn itself (belt-and-suspenders wrap in safe-spawn.ts)", async () => {
		startSpawnUsageSamplerMock.mockImplementationOnce(() => {
			throw new Error("sampler init failed");
		});

		const result = await safeSpawnAsync(NODE, EXIT_OK);
		expect(result.status).toBe(0);
		expect(result.resourceUsage).toBeUndefined();
	});
});
// flake-shape: real-process-spawn — real child CPU and RSS samples prove usage bracketing around the spawn boundary
