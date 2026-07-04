import { beforeEach, describe, expect, it, vi } from "vitest";

const safeSpawnAsync = vi.fn();
const safeSpawn = vi.fn();
const ensureTool = vi.fn();

vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync, safeSpawn }));
vi.mock("../../clients/installer/index.js", () => ({ ensureTool }));

describe("BiomeClient.ensureAvailable() — in-flight dedupe (#120)", () => {
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
		const { BiomeClient } = await import("../../clients/biome-client.js");
		const client = new BiomeClient();
		const a = client.ensureAvailable();
		const b = client.ensureAvailable();
		const c = client.ensureAvailable();
		// Binary resolution now awaits a global-bin lookup (#375) before the probe
		// spawns, so flush microtasks; the dedupe still means exactly ONE probe.
		await new Promise((r) => setTimeout(r, 0));
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		resolveProbe?.({
			status: 0,
			error: null,
			stdout: "biome 1.9.4",
			stderr: "",
		});
		const results = await Promise.all([a, b, c]);
		expect(results).toEqual([true, true, true]);
		// Cache is now hot — subsequent calls short-circuit before spawning.
		await client.ensureAvailable();
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});

	it("clears ensureInFlight after a failed probe so the in-flight slot doesn't leak", async () => {
		safeSpawnAsync.mockResolvedValueOnce({
			status: 1,
			error: new Error("not found"),
			stdout: "",
			stderr: "",
		});
		const { BiomeClient } = await import("../../clients/biome-client.js");
		const client = new BiomeClient();
		const first = await client.ensureAvailable();
		expect(first).toBe(false);
		await client.ensureAvailable();
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});
});
