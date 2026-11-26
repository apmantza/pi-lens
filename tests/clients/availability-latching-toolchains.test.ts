/**
 * #1476 sweep result — `GoClient` and `RustClient` carried the same latch shape
 * as the three sites the issue named: the PATH candidate is resolved by
 * spawning `go version` / `cargo --version` against a 3 s host-side budget, and
 * ANY failure was memoized as "no toolchain" for the life of the process. A
 * stalled event loop at warm-up silently disabled every Go or Rust diagnostic
 * until restart.
 *
 * `node:fs` is mocked so the absolute install-path candidates never resolve:
 * whether a dev box or CI image happens to have Go installed must not decide
 * what these tests exercise.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSIENT_BASE_COOLDOWN_MS } from "../../clients/dispatch/runners/utils/availability-policy.js";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
	safeSpawn: vi.fn(),
	isCommandAvailableAsync: vi.fn(async () => false),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, default: actual, existsSync: () => false };
});

const timeoutResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: new Error("Process timed out after 3000ms"),
	failure: "timeout",
	spawnFailure: { kind: "timeout" },
};

const missingResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
	failure: "spawn",
	spawnFailure: { kind: "tool-not-found" },
};

const okResult = (stdout: string) => ({
	stdout,
	stderr: "",
	status: 0,
	error: undefined,
});

function advancePastCooldown(): void {
	vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.useFakeTimers({ toFake: ["Date"] });
	return () => vi.useRealTimers();
});

describe("GoClient availability (#1476)", () => {
	it("pins a successful probe: available", async () => {
		safeSpawnAsync.mockResolvedValue(okResult("go version go1.23.0"));
		const { GoClient } = await import("../../clients/go-client.js");
		const client = new GoClient();

		expect(await client.isGoAvailableAsync()).toBe(true);
	});

	it("pins a genuine absence: latched false, no re-probe", async () => {
		safeSpawnAsync.mockResolvedValue(missingResult);
		const { GoClient } = await import("../../clients/go-client.js");
		const client = new GoClient();

		expect(await client.isGoAvailableAsync()).toBe(false);
		const probes = safeSpawnAsync.mock.calls.length;
		expect(probes).toBeGreaterThan(0);
		expect(await client.isGoAvailableAsync()).toBe(false);
		expect(safeSpawnAsync.mock.calls.length).toBe(probes);
	});

	it("a timed-out probe expires, and Go comes back without a restart", async () => {
		safeSpawnAsync.mockResolvedValue(timeoutResult);
		const { GoClient } = await import("../../clients/go-client.js");
		const client = new GoClient();

		expect(await client.isGoAvailableAsync()).toBe(false);
		const probes = safeSpawnAsync.mock.calls.length;
		// Held inside the cooldown — a sick host is not re-probed on every call.
		expect(await client.isGoAvailableAsync()).toBe(false);
		expect(safeSpawnAsync.mock.calls.length).toBe(probes);

		advancePastCooldown();
		safeSpawnAsync.mockResolvedValue(okResult("go version go1.23.0"));
		expect(await client.isGoAvailableAsync()).toBe(true);
	});

	it("concurrent first-time callers share one sweep (no probe storm)", async () => {
		safeSpawnAsync.mockResolvedValue(okResult("go version go1.23.0"));
		const { GoClient } = await import("../../clients/go-client.js");
		const client = new GoClient();

		const results = await Promise.all([
			client.isGoAvailableAsync(),
			client.isGoAvailableAsync(),
			client.isGoAvailableAsync(),
		]);
		expect(results).toEqual([true, true, true]);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});
});

describe("RustClient availability (#1476)", () => {
	it("pins a successful probe: available", async () => {
		safeSpawnAsync.mockResolvedValue(okResult("cargo 1.82.0"));
		const { RustClient } = await import("../../clients/rust-client.js");
		const client = new RustClient();

		expect(await client.isAvailableAsync()).toBe(true);
	});

	it("pins a genuine absence: latched false, no re-probe", async () => {
		safeSpawnAsync.mockResolvedValue(missingResult);
		const { RustClient } = await import("../../clients/rust-client.js");
		const client = new RustClient();

		expect(await client.isAvailableAsync()).toBe(false);
		const probes = safeSpawnAsync.mock.calls.length;
		expect(probes).toBeGreaterThan(0);
		expect(await client.isAvailableAsync()).toBe(false);
		expect(safeSpawnAsync.mock.calls.length).toBe(probes);
	});

	it("a timed-out probe expires, and cargo comes back without a restart", async () => {
		safeSpawnAsync.mockResolvedValue(timeoutResult);
		const { RustClient } = await import("../../clients/rust-client.js");
		const client = new RustClient();

		expect(await client.isAvailableAsync()).toBe(false);
		advancePastCooldown();
		safeSpawnAsync.mockResolvedValue(okResult("cargo 1.82.0"));
		expect(await client.isAvailableAsync()).toBe(true);
	});

	it("concurrent first-time callers share one sweep (no probe storm)", async () => {
		safeSpawnAsync.mockResolvedValue(okResult("cargo 1.82.0"));
		const { RustClient } = await import("../../clients/rust-client.js");
		const client = new RustClient();

		const results = await Promise.all([
			client.isAvailableAsync(),
			client.isAvailableAsync(),
			client.isAvailableAsync(),
		]);
		expect(results).toEqual([true, true, true]);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});
});
