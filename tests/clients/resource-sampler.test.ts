/**
 * Tests for clients/resource-sampler.ts (#620) — the CPU/RSS sampling seam
 * used both for long-lived-process heartbeat sampling (instance-registry
 * host + LSP children) and transient-spawn bracketing (safe-spawn.ts).
 *
 * The sampler is platform-split: on Linux/macOS it uses `pidusage` (mocked
 * here so tests never touch a real process table); on Windows it runs a fully
 * guarded `Get-CimInstance Win32_Process` query (the `node:child_process`
 * `spawn` is mocked so tests never spawn a real process, and each test drives
 * the fake child's stdout / error / exit to exercise a specific path). Both
 * branches are exercised by forcing `process.platform` per describe block, so
 * coverage is identical regardless of the host OS this suite runs on.
 *
 * The whole point of the Windows path is #533/#620: pidusage's unguarded
 * internal spawn could throw `spawn UNKNOWN` synchronously in a detached
 * callback → uncaughtException → the pi host crashes. The regression tests
 * below simulate that spawn failing every way (sync throw / error event /
 * non-zero exit) and assert `sampleProcesses` still RESOLVES — a sampling
 * failure can only ever lose a data point, never crash the caller.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

const pidusageMock = vi.fn();
vi.mock("pidusage", () => ({
	default: (...args: unknown[]) => pidusageMock(...args),
}));

// Controllable fake `spawn`. Each test assigns `fakeSpawn` to shape the child's
// behavior (emit stdout, emit an "error" event, close with a code, or throw
// synchronously). Defaults to a child that closes immediately with empty
// output — the neutral "no data this tick" shape.
type SpawnFn = (...args: unknown[]) => unknown;
let fakeSpawn: SpawnFn = () => makeFakeChild({ stdout: "" });
const timeoutControl = vi.hoisted(() => ({
	handler: undefined as
		| ((child: unknown, options: unknown) => Promise<"gone">)
		| undefined,
	called: false,
}));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (...args: unknown[]) => fakeSpawn(...args),
	};
});
vi.mock("../../clients/instance-reaper.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/instance-reaper.js")>();
	return {
		...actual,
		terminateScannerChild: async (child: unknown, options: unknown) => {
			timeoutControl.called = true;
			return timeoutControl.handler?.(child, options) ?? "gone";
		},
	};
});

const {
	sampleProcesses,
	UsageAccumulator,
	walkDescendantPids,
	startSpawnUsageSampler,
	sampleProcessTreeCpuPercent,
	__resetWindowsCpuHistoryForTests,
	__windowsCpuHistorySizeForTests,
	__windowsCpuHistoryHasForTests,
} = await import("../../clients/resource-sampler.js");

/**
 * Build a fake ChildProcess that emits `stdout` (if any) then fires `close`
 * with `code`, all on the microtask queue so `await`-ing the sampler flushes
 * them. `emitError: true` fires an "error" event instead of closing normally.
 */
interface FakeChild {
	stdout: {
		on: (event: string, cb: (chunk: Buffer) => void) => void;
		unref: ReturnType<typeof vi.fn>;
	};
	once: (event: string, cb: (...a: unknown[]) => void) => void;
	unref: ReturnType<typeof vi.fn>;
}

function makeFakeChild(opts: {
	stdout?: string;
	code?: number;
	emitError?: boolean;
	holdOpen?: boolean;
}): FakeChild {
	const handlers = new Map<string, (...a: unknown[]) => void>();
	const dataCbs: Array<(chunk: Buffer) => void> = [];
	const child = {
		stdout: {
			on: (event: string, cb: (chunk: Buffer) => void) => {
				if (event === "data") dataCbs.push(cb);
			},
			unref: vi.fn(),
		},
		once: (event: string, cb: (...a: unknown[]) => void) => {
			handlers.set(event, cb);
		},
		unref: vi.fn(),
		pid: 4242,
	};
	queueMicrotask(() => {
		if (opts.holdOpen) return;
		if (opts.emitError) {
			handlers.get("error")?.(new Error("spawn failed (async)"));
			return;
		}
		if (opts.stdout) {
			for (const cb of dataCbs) cb(Buffer.from(opts.stdout));
		}
		handlers.get("close")?.(opts.code ?? 0, null);
	});
	return child;
}

const realPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		value: platform,
		configurable: true,
	});
}
function requireMap<T>(result: Map<number, T> | null): Map<number, T> {
	if (result === null) throw new Error("expected a completed sample");
	return result;
}
afterEach(() => {
	setPlatform(realPlatform);
	fakeSpawn = () => makeFakeChild({ stdout: "" });
	timeoutControl.handler = undefined;
	timeoutControl.called = false;
	resetDegradationLedger();
});

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

describe("sampleProcesses (POSIX / pidusage path)", () => {
	beforeEach(() => {
		pidusageMock.mockReset();
		setPlatform("linux");
	});

	it("returns an empty map and never calls pidusage for an empty pid list", async () => {
		const result = requireMap(await sampleProcesses([]));
		expect(result.size).toBe(0);
		expect(pidusageMock).not.toHaveBeenCalled();
	});

	it("maps resolved stats back onto their numeric pid", async () => {
		pidusageMock.mockResolvedValue({
			"111": { cpu: 12.5, memory: 1024 },
			"222": { cpu: 0, memory: 2048 },
		});

		const result = requireMap(await sampleProcesses([111, 222]));
		expect(result.get(111)).toEqual({ cpuPercent: 12.5, rssBytes: 1024 });
		expect(result.get(222)).toEqual({ cpuPercent: 0, rssBytes: 2048 });
	});

	it("leaves a pid absent from the result when pidusage can't resolve it", async () => {
		pidusageMock.mockResolvedValue({ "111": { cpu: 5, memory: 512 } });

		const result = requireMap(await sampleProcesses([111, 999]));
		expect(result.has(111)).toBe(true);
		expect(result.has(999)).toBe(false);
	});

	for (const [label, stats] of [
		["NaN CPU", { cpu: Number.NaN, memory: 512 }],
		["infinite CPU", { cpu: Number.POSITIVE_INFINITY, memory: 512 }],
		["negative CPU", { cpu: -1, memory: 512 }],
		["infinite memory", { cpu: 2, memory: Number.POSITIVE_INFINITY }],
		["negative memory", { cpu: 2, memory: -1 }],
	] as const) {
		it(`leaves ${label} usage unmeasured`, async () => {
			pidusageMock.mockResolvedValue({ "111": stats });
			expect(requireMap(await sampleProcesses([111])).has(111)).toBe(false);
		});
	}

	it("treats a rejected pidusage query as unknown, not an empty map", async () => {
		pidusageMock.mockRejectedValue(new Error("boom"));

		await expect(sampleProcesses([111])).resolves.toBeNull();
		expect(
			getDegradationSummary().find(
				(g) => g.kind === "resource-sampler-query-failed",
			),
		).toMatchObject({
			latestReasons: [{ subject: "posix-pidusage-process-table" }],
		});
	});

	it("de-duplicates and drops invalid pids before sampling", async () => {
		pidusageMock.mockResolvedValue({ "111": { cpu: 1, memory: 1 } });

		await sampleProcesses([111, 111, -1, Number.NaN, 0]);
		expect(pidusageMock).toHaveBeenCalledWith([111]);
	});
});

describe("sampleProcesses (Windows / guarded CIM path)", () => {
	beforeEach(() => {
		pidusageMock.mockReset();
		__resetWindowsCpuHistoryForTests();
		setPlatform("win32");
		resetDegradationLedger();
	});

	it("never calls pidusage on Windows — the whole point of the fix", async () => {
		fakeSpawn = () =>
			makeFakeChild({
				stdout: "111,1024,0,0,2026-08-30T00:00:00Z\r\n",
				code: 0,
			});
		await sampleProcesses([111]);
		expect(pidusageMock).not.toHaveBeenCalled();
	});

	it("parses RSS (WorkingSetSize) from the CIM output; first tick reports cpu 0", async () => {
		// One line: pid,workingSet,kernel100ns,user100ns
		fakeSpawn = () =>
			makeFakeChild({
				stdout:
					"111,4096,0,0,2026-08-30T00:00:00Z\r\n222,8192,0,0,2026-08-30T00:00:01Z\r\n",
				code: 0,
			});

		const result = requireMap(await sampleProcesses([111, 222]));
		expect(result.get(111)).toEqual({ rssBytes: 4096, cpuPercent: 0 });
		expect(result.get(222)).toEqual({ rssBytes: 8192, cpuPercent: 0 });
	});

	it("computes CPU% from the kernel+user delta over elapsed wall time on the second tick", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(0);
			// Tick 1: cumulative CPU time = 0 (kernel=0,user=0). Seeds history.
			fakeSpawn = () =>
				makeFakeChild({
					stdout: "111,4096,0,0,2026-08-30T00:00:00Z\r\n",
					code: 0,
				});
			const first = requireMap(await sampleProcesses([111]));
			expect(first.get(111)).toEqual({ rssBytes: 4096, cpuPercent: 0 });

			// 10s of wall time elapses; the process burned 5s of CPU.
			// UserModeTime is in 100 ns units → 5000 ms = 5000 * 1e4 = 5e7 units.
			vi.setSystemTime(10_000);
			fakeSpawn = () =>
				makeFakeChild({
					stdout: "111,4096,0,50000000,2026-08-30T00:00:00Z\r\n",
					code: 0,
				});
			const second = requireMap(await sampleProcesses([111]));
			// 5000 ms CPU / 10000 ms wall * 100 = 50%.
			expect(second.get(111)?.cpuPercent).toBeCloseTo(50);
			expect(second.get(111)?.rssBytes).toBe(4096);
		} finally {
			vi.useRealTimers();
		}
	});

	it("invalidates CPU history when Windows reuses a PID", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(0);
			fakeSpawn = () =>
				makeFakeChild({ stdout: "111,4096,0,0,2026-08-30T00:00:00Z\r\n" });
			await sampleProcesses([111]);
			vi.setSystemTime(10_000);
			fakeSpawn = () =>
				makeFakeChild({
					stdout: "111,4096,0,50000000,2026-08-30T00:01:00Z\r\n",
				});
			const replacement = requireMap(await sampleProcesses([111]));
			// The large inherited counter delta belongs to the predecessor. A
			// replacement starts at zero instead of appearing busy.
			expect(replacement.get(111)?.cpuPercent).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("treats a Windows counter reset as unmeasured for that tick", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(0);
			fakeSpawn = () =>
				makeFakeChild({
					stdout: "111,4096,10000000,0,2026-08-30T00:00:00Z\r\n",
				});
			await sampleProcesses([111]);
			vi.setSystemTime(10_000);
			fakeSpawn = () =>
				makeFakeChild({ stdout: "111,4096,0,0,2026-08-30T00:00:00Z\r\n" });
			expect(requireMap(await sampleProcesses([111])).has(111)).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	for (const [label, row] of [
		["empty kernel", "111,4096,,0,2026-08-30T00:00:00Z"],
		["empty user", "111,4096,0,,2026-08-30T00:00:00Z"],
		["nonfinite kernel", "111,4096,NaN,0,2026-08-30T00:00:00Z"],
		["nonfinite user", "111,4096,0,Infinity,2026-08-30T00:00:00Z"],
		["negative kernel", "111,4096,-1,0,2026-08-30T00:00:00Z"],
		["negative user", "111,4096,0,-1,2026-08-30T00:00:00Z"],
		["negative RSS", "111,-1,0,0,2026-08-30T00:00:00Z"],
		["missing creation identity", "111,4096,0,0,"],
	] as const) {
		it(`leaves ${label} Windows usage unmeasured`, async () => {
			fakeSpawn = () => makeFakeChild({ stdout: `${row}\r\n` });
			expect(requireMap(await sampleProcesses([111])).has(111)).toBe(false);
		});
	}

	it("caps dated PID history and evicts the oldest entry", async () => {
		const rows = Array.from(
			{ length: 4_097 },
			(_, index) => `${index + 1},1,0,0,2026-08-30T00:00:${index}Z`,
		).join("\r\n");
		fakeSpawn = () => makeFakeChild({ stdout: rows });
		await sampleProcesses(Array.from({ length: 4_097 }, (_, i) => i + 1));
		expect(__windowsCpuHistorySizeForTests()).toBeLessThanOrEqual(4_096);
		expect(__windowsCpuHistoryHasForTests(1, "2026-08-30T00:00:0Z")).toBe(
			false,
		);
		expect(
			__windowsCpuHistoryHasForTests(4_097, "2026-08-30T00:00:4096Z"),
		).toBe(true);
	});

	it("marks a missing target unmeasured while tolerating missing descendants", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(0);
			const outputs = [
				"200,0\r\n", // descendant query: one child
				"111,4096,0,0,2026-08-30T00:00:00Z\r\n", // target only
				"200,0\r\n",
				"200,4096,0,50000000,2026-08-30T00:00:00Z\r\n", // target gone
			];
			fakeSpawn = () => makeFakeChild({ stdout: outputs.shift() ?? "" });
			const resultPromise = sampleProcessTreeCpuPercent(111, 1, 10);
			await vi.runAllTimersAsync();
			await expect(resultPromise).resolves.toMatchObject({
				busy: false,
				measured: false,
				cpuPercent: null,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	// --- Crash regression: the sampler must NEVER throw/reject (#533, #620) ---

	it("RESOLVES (never rejects) when spawn throws SYNCHRONOUSLY — the spawn UNKNOWN crash vector", async () => {
		fakeSpawn = () => {
			// This is exactly what pidusage's unguarded internal spawn does under
			// Windows handle/commit pressure: throw `spawn UNKNOWN` synchronously.
			const err = new Error("spawn UNKNOWN") as Error & {
				errno: number;
				code: string;
				syscall: string;
			};
			err.errno = -4094;
			err.code = "UNKNOWN";
			err.syscall = "spawn";
			throw err;
		};

		await expect(sampleProcesses([111])).resolves.toBeNull();
		const result = await sampleProcesses([111]);
		expect(result).toBeNull();
		expect(
			getDegradationSummary().find(
				(g) => g.kind === "resource-sampler-query-failed",
			),
		).toMatchObject({
			count: 1,
			latestReasons: [{ subject: "windows-process-table" }],
		});
	});

	it("RESOLVES when the child emits an async 'error' event (e.g. ENOENT)", async () => {
		fakeSpawn = () => makeFakeChild({ emitError: true });
		await expect(sampleProcesses([111])).resolves.toBeNull();
	});

	it("reports an errored outcome when the child exits non-zero with garbage stdout", async () => {
		fakeSpawn = () =>
			makeFakeChild({ stdout: "not-a-csv-line\r\n<<broken>>\r\n", code: 1 });
		await expect(sampleProcesses([111])).resolves.toBeNull();
		expect(
			getDegradationSummary().find(
				(g) => g.kind === "resource-sampler-query-failed",
			),
		).toMatchObject({
			count: 1,
			latestReasons: [
				{
					subject: "windows-process-table",
					reason: "process-table query exit-error (exit code 1)",
				},
			],
		});
	});

	it("does not settle a timed-out sampler query until the tree-kill hook reports the child's fate", async () => {
		vi.useFakeTimers();
		let release!: (outcome: "gone") => void;
		timeoutControl.handler = async () =>
			new Promise<"gone">((resolve) => {
				release = resolve;
			});
		fakeSpawn = () => makeFakeChild({ holdOpen: true });
		let settled = false;
		const query = sampleProcesses([111]).then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(2_000);
		expect(timeoutControl.called).toBe(true);
		expect(settled).toBe(false);
		release("gone");
		await query;
		expect(settled).toBe(true);
	});

	it("does not turn a failed descendant process-table query into an empty tree", async () => {
		fakeSpawn = () => makeFakeChild({ emitError: true });
		vi.useFakeTimers();
		try {
			const sampler = startSpawnUsageSampler(999, 100);
			await vi.advanceTimersByTimeAsync(0);
			expect(sampler.stop()).toBeNull();
			expect(
				getDegradationSummary().find(
					(g) => g.kind === "resource-sampler-query-failed",
				),
			).toMatchObject({
				count: 1,
				latestReasons: [{ subject: "windows-descendant-process-table" }],
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns an empty map and never spawns for an empty pid list", async () => {
		const spy = vi.fn(() => makeFakeChild({ stdout: "" }));
		fakeSpawn = spy;
		const result = requireMap(await sampleProcesses([]));
		expect(result.size).toBe(0);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("resource-sampler: fire-and-forget CIM spawns are unref'd (#1155)", () => {
	// Mirrors tests/clients/instance-reaper-unref.test.ts's shape (#1153/#1160):
	// a piped, `data`-listener-attached child re-references the libuv loop even
	// after `child.unref()` unless its stdout pipe is unref'd too — this module
	// has TWO such spawns (sampleProcessesWindows's CIM query, and
	// findDescendantPidsWindows's descendant-tree CIM query used by
	// startSpawnUsageSampler on Windows), and both must be unref'd.
	beforeEach(() => {
		pidusageMock.mockReset();
		__resetWindowsCpuHistoryForTests();
		setPlatform("win32");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("sampleProcesses (sampleProcessesWindows) unrefs its CIM child + stdout", async () => {
		const spawned: ReturnType<typeof makeFakeChild>[] = [];
		fakeSpawn = () => {
			const child = makeFakeChild({
				stdout: "111,4096,0,0,2026-08-30T00:00:00Z\r\n",
				code: 0,
			});
			spawned.push(child);
			return child;
		};

		await sampleProcesses([111]);

		expect(spawned.length).toBeGreaterThanOrEqual(1);
		for (const child of spawned) {
			expect(child.unref).toHaveBeenCalled();
			expect(child.stdout.unref).toHaveBeenCalled();
		}
	});

	it("startSpawnUsageSampler (findDescendantPidsWindows) unrefs its CIM child + stdout", async () => {
		vi.useFakeTimers();
		const spawned: ReturnType<typeof makeFakeChild>[] = [];
		fakeSpawn = () => {
			// Every call here is the descendant-lookup query (pid,parentPid CSV) —
			// empty output resolves to no descendants, which is fine; the point is
			// only to observe the spawned child's unref calls.
			const child = makeFakeChild({ stdout: "", code: 0 });
			spawned.push(child);
			return child;
		};

		const sampler = startSpawnUsageSampler(999, 100);
		await vi.advanceTimersByTimeAsync(0); // flush the immediate tick
		sampler.stop();

		expect(spawned.length).toBeGreaterThanOrEqual(1);
		for (const child of spawned) {
			expect(child.unref).toHaveBeenCalled();
			expect(child.stdout.unref).toHaveBeenCalled();
		}
	});
});

describe("startSpawnUsageSampler", () => {
	beforeEach(() => {
		pidusageMock.mockReset();
		// Force POSIX so the tick samples the bare pid via pidusage (no CIM
		// descendant lookup) — keeps these focused on the accumulate/bracket
		// logic; the Windows sampling path is covered above.
		setPlatform("linux");
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
