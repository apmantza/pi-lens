import { beforeEach, describe, expect, it, vi } from "vitest";

const safeSpawnAsync = vi.fn();
const safeSpawn = vi.fn();
const ensureTool = vi.fn();

vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync, safeSpawn }));
vi.mock("../../clients/installer/index.js", () => ({
	// #2140: the probe resolver asks the installer for a release-managed
	// binary (`~/.pi-lens/bin`) before falling back to PATH. Undefined is
	// "no managed install", which is what these tests already assumed.
	findManagedToolBinary: vi.fn(async () => undefined),
	ensureTool,
	// #1612: resolveAvailableOrInstallUnshared reads these on the install-
	// success path to derive honest evidence rather than asserting "succeeded".
	getInstallAttempt: vi.fn(() => undefined),
	// #1636: read alongside getInstallAttempt for the compensating row's
	// `resolved` tag. Undefined falls back to "cache".
	getLastEnsureResolutionSource: vi.fn(() => undefined),
	getToolInstallStrategy: vi.fn(() => undefined),
	resetPathWalkMemo: vi.fn(),
	// Seam probes route through this on cached hits (#1203); default spawnable.
	isSpawnableCommand: vi.fn(async () => true),
}));

describe("RuffClient.ensureAvailable() — in-flight dedupe (#120)", () => {
	beforeEach(async () => {
		vi.resetAllMocks();
		const helpers =
			await import("../../clients/dispatch/runners/utils/runner-helpers.js");
		helpers.resetDispatchAvailabilityState();
		ensureTool.mockResolvedValue(null);
	});

	it("dedupes concurrent first-time callers to a single probe", async () => {
		let resolveProbe: ((value: unknown) => void) | undefined;
		safeSpawnAsync.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveProbe = resolve;
				}),
		);
		const { RuffClient } = await import("../../clients/ruff-client.js");
		const client = new RuffClient();
		const a = client.ensureAvailable();
		const b = client.ensureAvailable();
		const c = client.ensureAvailable();
		await vi.waitFor(() => expect(safeSpawnAsync).toHaveBeenCalledTimes(1));
		resolveProbe?.({
			status: 0,
			error: undefined,
			stdout: "ruff 0.6.0",
			stderr: "",
		});
		const results = await Promise.all([a, b, c]);
		expect(results).toEqual([true, true, true]);
		// Cache is now hot — subsequent calls short-circuit before spawning.
		await client.ensureAvailable();
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});

	it("clears ensureInFlight after a failed probe so retries can run", async () => {
		safeSpawnAsync.mockResolvedValueOnce({
			status: 1,
			error: new Error("not found"),
			stdout: "",
			stderr: "",
		});
		const { RuffClient } = await import("../../clients/ruff-client.js");
		const client = new RuffClient();
		const first = await client.ensureAvailable();
		expect(first).toBe(false);
		// A second call is allowed to probe again since the cached value is
		// false, not null — RuffClient does not retry, but we want to confirm
		// the in-flight slot did not leak.
		await client.ensureAvailable();
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});

	it("uses the managed executable after PATH installation", async () => {
		const managed = "/fake/managed/ruff";
		safeSpawnAsync
			.mockResolvedValueOnce({
				status: 1,
				error: Object.assign(new Error("not found"), { code: "ENOENT" }),
				failure: "spawn",
				spawnFailure: { kind: "tool-not-found" } as never,
				stdout: "",
				stderr: "",
			})
			.mockResolvedValue({
				status: 0,
				error: undefined,
				stdout: "[]",
				stderr: "",
			});
		ensureTool.mockResolvedValue(managed);
		const { RuffClient } = await import("../../clients/ruff-client.js");
		const client = new RuffClient();
		const file = `${process.cwd()}\\ruff-managed-test.py`;
		const fs = await import("node:fs");
		fs.writeFileSync(file, "x = 1\n");
		try {
			await client.fixFileAsync(file);
			expect(safeSpawnAsync.mock.calls.slice(1).map((call) => call[0])).toEqual(
				[managed, managed],
			);
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	it("suppresses failed installs until the session resets", async () => {
		safeSpawnAsync.mockResolvedValue({
			status: 1,
			error: Object.assign(new Error("not found"), { code: "ENOENT" }),
			failure: "spawn",
			spawnFailure: { kind: "tool-not-found" } as never,
			stdout: "",
			stderr: "",
		});
		const { RuffClient } = await import("../../clients/ruff-client.js");
		const client = new RuffClient();
		expect(await client.ensureAvailable()).toBe(false);
		expect(ensureTool).toHaveBeenCalledTimes(1);
		await client.ensureAvailable();
		expect(ensureTool).toHaveBeenCalledTimes(1);
		const helpers =
			await import("../../clients/dispatch/runners/utils/runner-helpers.js");
		helpers.resetDispatchAvailabilityState();
		ensureTool.mockResolvedValue("ruff");
		expect(await client.ensureAvailable()).toBe(true);
		expect(ensureTool).toHaveBeenCalledTimes(2);
	});
});
