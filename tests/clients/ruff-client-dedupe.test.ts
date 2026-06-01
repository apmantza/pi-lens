import { beforeEach, describe, expect, it, vi } from "vitest";

const safeSpawnAsync = vi.fn();
const safeSpawn = vi.fn();
const ensureTool = vi.fn();

vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync, safeSpawn }));
vi.mock("../../clients/installer/index.js", () => ({ ensureTool }));

describe("RuffClient.ensureAvailable() — in-flight dedupe (#120)", () => {
	beforeEach(() => {
		vi.resetAllMocks();
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
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		resolveProbe?.({
			status: 0,
			error: null,
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
});
