import { afterEach, describe, expect, it, vi } from "vitest";

// Simulate a runtime that doesn't implement perf_hooks.monitorEventLoopDelay
// (e.g. Bun < 1.3, which throws ERR_NOT_IMPLEMENTED when it is CALLED). The
// monitor is purely observational, so extension load must NOT crash — it must
// degrade to "no stats". Regression guard for the bun-compat fix.
vi.mock("node:perf_hooks", () => ({
	monitorEventLoopDelay: () => {
		throw Object.assign(
			new Error("perf_hooks.monitorEventLoopDelay is not yet implemented in Bun."),
			{ code: "ERR_NOT_IMPLEMENTED" },
		);
	},
}));

const { startEventLoopMonitor, getEventLoopStats, _stopEventLoopMonitorForTest } =
	await import("../../clients/event-loop-monitor.js");

describe("event-loop-monitor — runtime without monitorEventLoopDelay", () => {
	afterEach(() => _stopEventLoopMonitorForTest());

	it("degrades instead of crashing extension load", () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => startEventLoopMonitor()).not.toThrow();
		expect(getEventLoopStats()).toBeUndefined();
		// logs exactly once (adequate logging; not on every repeated start)
		startEventLoopMonitor();
		expect(errSpy).toHaveBeenCalledTimes(1);
		expect(String(errSpy.mock.calls[0]?.[0])).toMatch(/telemetry disabled/i);
		errSpy.mockRestore();
	});
});
