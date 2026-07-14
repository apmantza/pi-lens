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
	(_pid: number | undefined, _intervalMs?: number) => ({ stop: stopMock }),
);
vi.mock("../../clients/resource-sampler.js", () => ({
	startSpawnUsageSampler: (pid: number | undefined, intervalMs?: number) =>
		startSpawnUsageSamplerMock(pid, intervalMs),
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

	it("starts the sampler right after spawn, with the child's pid", async () => {
		stopMock.mockReturnValue(null);
		const result = await safeSpawnAsync(NODE, EXIT_OK);

		expect(startSpawnUsageSamplerMock).toHaveBeenCalledTimes(1);
		const [pidArg] = startSpawnUsageSamplerMock.mock.calls[0];
		expect(typeof pidArg).toBe("number");
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
				metadata: expect.objectContaining({ command: "fake-runner", ...summary }),
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

	it("still stops the sampler exactly once and resolves cleanly for a non-existent command", async () => {
		stopMock.mockReturnValue(null);
		const result = await safeSpawnAsync("this-command-does-not-exist-620", []);

		expect(stopMock).toHaveBeenCalledTimes(1);
		// Windows: shell:true means cmd.exe itself starts fine and reports the
		// unknown command via a non-zero exit code (not a spawn "error" event);
		// POSIX: shell:false spawn fails to exec and surfaces via "error".
		// Either way the sampler must have been stopped exactly once (asserted
		// above) — that's the behavior under test, not which path fired.
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
