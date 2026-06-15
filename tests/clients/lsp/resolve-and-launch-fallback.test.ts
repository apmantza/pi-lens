import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the launch primitive and the latency logger so we can drive the
// candidate fallback chain and inspect what gets logged.
const { launchLSP } = vi.hoisted(() => ({ launchLSP: vi.fn() }));
const { logLatency } = vi.hoisted(() => ({ logLatency: vi.fn() }));
vi.mock("../../../clients/lsp/launch.js", () => ({ launchLSP }));
vi.mock("../../../clients/latency-logger.js", () => ({ logLatency }));
vi.mock("../../../clients/installer/index.js", () => ({
	ensureTool: vi.fn(async () => null),
	getToolEnvironment: () => ({}),
}));

import { resolveAndLaunch } from "../../../clients/lsp/server.ts";

const fakeProc = { stdout: {}, stderr: {} } as never;
const failedPhases = () =>
	logLatency.mock.calls.filter(
		(c) => c[0]?.phase === "lsp_launch_candidate_failed",
	);

// #(bash-noise): a candidate that fails while a LATER candidate succeeds is just
// fallback — it must NOT be logged as a failure (that flooded the logs and read
// as an lsp-availability smell). Failures are surfaced only when ALL candidates fail.
describe("resolveAndLaunch — fallback failures are deferred", () => {
	beforeEach(() => {
		launchLSP.mockReset();
		logLatency.mockReset();
	});

	it("does NOT log candidate-failed when a later candidate succeeds", async () => {
		launchLSP
			.mockRejectedValueOnce(new Error("npm .cmd shim failed")) // idx 0
			.mockRejectedValueOnce(new Error("binary not found")) // idx 1
			.mockResolvedValueOnce(fakeProc); // idx 2 succeeds

		const result = await resolveAndLaunch(
			{ candidates: ["x.cmd", "x.exe", "x"], args: [], cwd: "/tmp/p" },
			false,
		);

		expect(result?.source).toBe("direct");
		expect(failedPhases()).toHaveLength(0); // the two fallbacks are NOT logged as failures
	});

	it("logs every candidate failure when ALL candidates fail", async () => {
		launchLSP
			.mockRejectedValueOnce(new Error("fail a"))
			.mockRejectedValueOnce(new Error("fail b"));

		const result = await resolveAndLaunch(
			{ candidates: ["a", "b"], args: [], cwd: "/tmp/p" }, // no managedToolId
			false,
		);

		expect(result).toBeUndefined();
		expect(failedPhases()).toHaveLength(2);
	});
});
