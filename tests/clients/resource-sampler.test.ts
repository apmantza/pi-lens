/**
 * Tests for clients/resource-sampler.ts (#620) — the CPU/RSS sampling seam
 * used both for long-lived-process heartbeat sampling (instance-registry
 * host + LSP children) and transient-spawn bracketing (safe-spawn.ts).
 *
 * `pidusage` is mocked throughout so these tests never touch real process
 * tables — mirrors clients/instance-reaper.ts's test style (pure decision
 * logic + injected fakes, no real spawns/kills).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pidusageMock = vi.fn();
vi.mock("pidusage", () => ({
	default: (...args: unknown[]) => pidusageMock(...args),
}));

// On Windows, startSpawnUsageSampler's poll tick resolves a live descendant
// tree via a real `powershell.exe`/CIM query (findDescendantPidsWindows) —
// mock `node:child_process` so these tests never spawn a real process for
// that lookup; the fake child "closes" immediately with empty output, so the
// descendant list is just `[]` and the sampler falls back to the bare pid.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: vi.fn(() => {
			const child = {
				stdout: { on: vi.fn() },
				once: (event: string, cb: (...args: unknown[]) => void) => {
					if (event === "close") queueMicrotask(() => cb(0));
				},
			};
			return child;
		}),
	};
});

const { sampleProcesses, UsageAccumulator, walkDescendantPids, startSpawnUsageSampler } =
	await import("../../clients/resource-sampler.js");

describe("UsageAccumulator (pure)", () => {
	it("returns null when no sample was ever added", () => {
		const acc = new UsageAccumulator();
		expect(acc.summarize()).toBeNull();
		expect(acc.count).toBe(0);
	});

	it("tracks peak and average across multiple samples", () => {
		const acc = new UsageAccumulator();
		acc.addSample({ cpuPercent: 10, rssBytes: 100 });
		acc.addSample({ cpuPercent: 50, rssBytes: 300 });
		acc.addSample({ cpuPercent: 20, rssBytes: 200 });

		const summary = acc.summarize();
		expect(summary).not.toBeNull();
		expect(summary?.sampleCount).toBe(3);
		expect(summary?.peakCpuPercent).toBe(50);
		expect(summary?.peakRssBytes).toBe(300);
		expect(summary?.avgCpuPercent).toBeCloseTo((10 + 50 + 20) / 3);
		expect(summary?.avgRssBytes).toBeCloseTo((100 + 300 + 200) / 3);
	});

	it("a single sample is both the peak and the average", () => {
		const acc = new UsageAccumulator();
		acc.addSample({ cpuPercent: 42, rssBytes: 4096 });
		const summary = acc.summarize();
		expect(summary?.peakCpuPercent).toBe(42);
		expect(summary?.avgCpuPercent).toBe(42);
		expect(summary?.peakRssBytes).toBe(4096);
		expect(summary?.avgRssBytes).toBe(4096);
	});
});

describe("walkDescendantPids (pure BFS)", () => {
	it("returns an empty array for a leaf pid with no children", () => {
		expect(walkDescendantPids(100, [])).toEqual([]);
	});

	it("finds direct children", () => {
		const pairs: Array<[number, number]> = [
			[200, 100],
			[201, 100],
		];
		const result = walkDescendantPids(100, pairs);
		expect(result.sort()).toEqual([200, 201]);
	});

	it("walks multiple generations (grandchildren)", () => {
		const pairs: Array<[number, number]> = [
			[200, 100], // child of root
			[300, 200], // grandchild via 200
			[301, 200],
		];
		const result = walkDescendantPids(100, pairs);
		expect(result.sort()).toEqual([200, 300, 301]);
	});

	it("does not include unrelated processes", () => {
		const pairs: Array<[number, number]> = [
			[200, 100],
			[999, 888], // unrelated tree
		];
		const result = walkDescendantPids(100, pairs);
		expect(result).toEqual([200]);
	});

	it("is cycle-safe against a malformed/cyclic snapshot", () => {
		// A real process tree can never have a cycle, but the walk must not hang
		// if the data is ever wrong (best-effort sampler).
		const pairs: Array<[number, number]> = [
			[100, 200], // 100's parent is 200
			[200, 100], // 200's parent is 100 — a cycle
		];
		expect(() => walkDescendantPids(100, pairs)).not.toThrow();
	});
});

describe("sampleProcesses", () => {
	beforeEach(() => {
		pidusageMock.mockReset();
	});

	it("returns an empty map and never calls pidusage for an empty pid list", async () => {
		const result = await sampleProcesses([]);
		expect(result.size).toBe(0);
		expect(pidusageMock).not.toHaveBeenCalled();
	});

	it("maps resolved stats back onto their numeric pid", async () => {
		pidusageMock.mockResolvedValue({
			"111": { cpu: 12.5, memory: 1024 },
			"222": { cpu: 0, memory: 2048 },
		});

		const result = await sampleProcesses([111, 222]);
		expect(result.get(111)).toEqual({ cpuPercent: 12.5, rssBytes: 1024 });
		expect(result.get(222)).toEqual({ cpuPercent: 0, rssBytes: 2048 });
	});

	it("leaves a pid absent from the result when pidusage can't resolve it", async () => {
		pidusageMock.mockResolvedValue({ "111": { cpu: 5, memory: 512 } });

		const result = await sampleProcesses([111, 999]);
		expect(result.has(111)).toBe(true);
		expect(result.has(999)).toBe(false);
	});

	it("never throws when pidusage itself rejects — returns an empty map", async () => {
		pidusageMock.mockRejectedValue(new Error("boom"));

		await expect(sampleProcesses([111])).resolves.toEqual(new Map());
	});

	it("de-duplicates and drops invalid pids before sampling", async () => {
		pidusageMock.mockResolvedValue({ "111": { cpu: 1, memory: 1 } });

		await sampleProcesses([111, 111, -1, Number.NaN, 0]);
		expect(pidusageMock).toHaveBeenCalledWith([111]);
	});
});

describe("startSpawnUsageSampler", () => {
	beforeEach(() => {
		pidusageMock.mockReset();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns a no-op sampler (stop() => null) for an undefined/invalid pid", () => {
		expect(startSpawnUsageSampler(undefined).stop()).toBeNull();
		expect(startSpawnUsageSampler(0).stop()).toBeNull();
		expect(startSpawnUsageSampler(-5).stop()).toBeNull();
	});

	it("samples immediately on start and again on each poll tick, aggregating into a summary", async () => {
		pidusageMock.mockResolvedValue({ "555": { cpu: 10, memory: 1000 } });

		const sampler = startSpawnUsageSampler(555, 100);
		await vi.advanceTimersByTimeAsync(0); // flush the immediate tick
		await vi.advanceTimersByTimeAsync(250); // ~2-3 more ticks at 100ms

		const summary = sampler.stop();
		expect(summary).not.toBeNull();
		expect(summary?.sampleCount).toBeGreaterThanOrEqual(2);
		expect(summary?.peakCpuPercent).toBe(10);
		expect(summary?.peakRssBytes).toBe(1000);
	});

	it("stop() before any tick lands returns null (never a fabricated zero reading)", () => {
		pidusageMock.mockImplementation(() => new Promise(() => {})); // never resolves
		const sampler = startSpawnUsageSampler(555, 100);
		expect(sampler.stop()).toBeNull();
	});

	it("a poll tick that rejects is silently skipped, not fatal to the sampler", async () => {
		pidusageMock.mockRejectedValue(new Error("pid gone"));

		const sampler = startSpawnUsageSampler(555, 100);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(300);

		expect(sampler.stop()).toBeNull(); // zero samples landed, but no throw anywhere
	});

	it("stop() is idempotent — calling it twice returns the same summary and doesn't throw", async () => {
		pidusageMock.mockResolvedValue({ "555": { cpu: 5, memory: 500 } });
		const sampler = startSpawnUsageSampler(555, 100);
		await vi.advanceTimersByTimeAsync(0);

		const first = sampler.stop();
		const second = sampler.stop();
		expect(second).toEqual(first);
	});
});
