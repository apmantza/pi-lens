/**
 * #533 — the pidusage bug class: a child_process `spawn()` that throws
 * SYNCHRONOUSLY (Windows `spawn UNKNOWN`/EINVAL) from inside a Promise executor
 * must NOT reject `safeSpawnAsync`. Every caller relies on the documented
 * never-reject contract (they inspect `result.error`), and many invoke it
 * fire-and-forget in best-effort/background paths — a rejection there could
 * surface as an unhandledRejection and crash the host. The fix wraps the
 * synchronous `spawn()` in try/catch and resolves with the error instead,
 * exactly as it already did for an asynchronously-emitted `'error'` event.
 *
 * The whole `node:child_process` module is mocked so `spawn` throws
 * synchronously (and `spawnSync` is a harmless no-op for the Windows
 * chcp/kill paths) — no real process is ever launched.
 */

import { describe, expect, it, vi } from "vitest";

const syncSpawnError = Object.assign(new Error("spawn UNKNOWN"), {
	code: "UNKNOWN",
	syscall: "spawn",
});

const spawnMock = vi.fn((..._args: unknown[]) => {
	throw syncSpawnError;
});

vi.mock("node:child_process", () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
	// Harmless no-op: the Windows chcp one-shot and taskkill paths call this.
	spawnSync: () => ({ stdout: "", stderr: "", status: 0, error: undefined }),
}));

// Keep the resource sampler inert so this test never touches pidusage.
vi.mock("../../clients/resource-sampler.js", () => ({
	startSpawnUsageSampler: () => ({ stop: () => null }),
}));

vi.mock("../../clients/latency-logger.js", () => ({
	logLatency: () => {},
}));

const { safeSpawnAsync } = await import("../../clients/safe-spawn.js");

describe("safeSpawnAsync contains a synchronous spawn throw (#533)", () => {
	it("resolves with the error instead of rejecting when spawn throws sync", async () => {
		// process.execPath is absolute + real, so Windows command resolution
		// succeeds and execution reaches the (mocked, throwing) spawn call.
		const promise = safeSpawnAsync(process.execPath, ["-e", "process.exit(0)"]);

		// Must RESOLVE, never reject — the host survives.
		await expect(promise).resolves.toBeDefined();
		const result = await promise;
		expect(result.status).toBeNull();
		expect(result.error).toBeInstanceOf(Error);
		expect(result.stdout).toBe("");
		expect(spawnMock).toHaveBeenCalled();
	});

	it("does not emit an unhandledRejection when spawn throws sync", async () => {
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown): void => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onRejection);
		try {
			// Fire-and-forget (the dangerous shape): no awaiting try/catch.
			void safeSpawnAsync(process.execPath, ["-e", "0"]);
			// Let any microtask-queued rejection surface.
			await new Promise((r) => setTimeout(r, 10));
		} finally {
			process.off("unhandledRejection", onRejection);
		}
		expect(rejections).toEqual([]);
	});
});
