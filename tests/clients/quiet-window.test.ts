import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	_resetBuiltinQuietWindowRegistrationForTests,
	_resetQuietWindowEnabledForTests,
	_resetQuietWindowTasksForTests,
	isQuietWindowEnabled,
	quietWindowWaitMs,
	registerBuiltinQuietWindowTasks,
	registerQuietWindowTask,
	runQuietWindow,
} from "../../clients/quiet-window.js";

describe("quiet-window", () => {
	const originalEnabledEnv = process.env.PI_LENS_QUIET_WINDOW;
	const originalWaitEnv = process.env.PI_LENS_QUIET_WINDOW_WAIT_MS;

	beforeEach(() => {
		_resetQuietWindowTasksForTests();
		_resetQuietWindowEnabledForTests();
		_resetBuiltinQuietWindowRegistrationForTests();
		delete process.env.PI_LENS_QUIET_WINDOW;
		delete process.env.PI_LENS_QUIET_WINDOW_WAIT_MS;
	});

	afterEach(() => {
		if (originalEnabledEnv === undefined) {
			delete process.env.PI_LENS_QUIET_WINDOW;
		} else {
			process.env.PI_LENS_QUIET_WINDOW = originalEnabledEnv;
		}
		if (originalWaitEnv === undefined) {
			delete process.env.PI_LENS_QUIET_WINDOW_WAIT_MS;
		} else {
			process.env.PI_LENS_QUIET_WINDOW_WAIT_MS = originalWaitEnv;
		}
		_resetQuietWindowTasksForTests();
		_resetQuietWindowEnabledForTests();
		_resetBuiltinQuietWindowRegistrationForTests();
	});

	it("runs registered tasks sequentially in registration order", async () => {
		const order: string[] = [];
		registerQuietWindowTask("first", async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			order.push("first");
		});
		registerQuietWindowTask("second", () => {
			order.push("second");
		});

		const dbg = vi.fn();
		await runQuietWindow({
			runtime: new RuntimeCoordinator(),
			dbg,
			cwd: "/tmp/proj",
		});

		expect(order).toEqual(["first", "second"]);
	});

	it("skips re-entrantly when a run is already in progress, without queuing", async () => {
		let releaseFirst: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let secondTaskRan = false;

		registerQuietWindowTask("blocking", async () => {
			await gate;
		});

		const dbg = vi.fn();
		const runtime = new RuntimeCoordinator();

		const firstRun = runQuietWindow({ runtime, dbg });
		// Give the first run a tick to set the in-progress flag.
		await new Promise((resolve) => setImmediate(resolve));

		const secondRun = runQuietWindow({ runtime, dbg }).then(() => {
			secondTaskRan = true;
		});

		releaseFirst?.();
		await firstRun;
		await secondRun;

		expect(secondTaskRan).toBe(true);
		expect(
			dbg.mock.calls.some((call) =>
				String(call[0]).includes("skipping — a previous run is still in progress"),
			),
		).toBe(true);
	});

	it("is a no-op under the kill switch PI_LENS_QUIET_WINDOW=0", async () => {
		process.env.PI_LENS_QUIET_WINDOW = "0";
		_resetQuietWindowEnabledForTests();
		expect(isQuietWindowEnabled()).toBe(false);

		const taskFn = vi.fn();
		registerQuietWindowTask("should-not-run", taskFn);

		await runQuietWindow({ runtime: new RuntimeCoordinator(), dbg: vi.fn() });

		expect(taskFn).not.toHaveBeenCalled();
	});

	it("isolates task failures — one throwing task does not prevent the rest from running", async () => {
		const order: string[] = [];
		registerQuietWindowTask("throws", () => {
			order.push("throws");
			throw new Error("boom");
		});
		registerQuietWindowTask("after", () => {
			order.push("after");
		});

		const dbg = vi.fn();
		await expect(
			runQuietWindow({ runtime: new RuntimeCoordinator(), dbg }),
		).resolves.toBeUndefined();

		expect(order).toEqual(["throws", "after"]);
		expect(
			dbg.mock.calls.some((call) => String(call[0]).includes('task "throws" failed')),
		).toBe(true);
	});

	describe("quietWindowWaitMs env parsing", () => {
		it("falls back to the 15000ms default when unset", () => {
			expect(quietWindowWaitMs()).toBe(15_000);
		});

		it("accepts a valid positive override", () => {
			process.env.PI_LENS_QUIET_WINDOW_WAIT_MS = "20000";
			expect(quietWindowWaitMs()).toBe(20_000);
		});

		it("rejects non-finite / non-positive values and falls back to the default", () => {
			for (const bad of ["not-a-number", "-5", "0", "NaN", "Infinity"]) {
				process.env.PI_LENS_QUIET_WINDOW_WAIT_MS = bad;
				expect(quietWindowWaitMs()).toBe(15_000);
			}
		});
	});

	it("logs a quiet_window phase entry shaped with per-task name/durationMs/ok", async () => {
		const latencyLogger = await import("../../clients/latency-logger.js");
		const spy = vi.spyOn(latencyLogger, "logLatency");

		registerQuietWindowTask("ok-task", () => {});
		registerQuietWindowTask("bad-task", () => {
			throw new Error("nope");
		});

		await runQuietWindow({ runtime: new RuntimeCoordinator(), dbg: vi.fn() });

		expect(spy).toHaveBeenCalledTimes(1);
		const entry = spy.mock.calls[0][0];
		expect(entry.phase).toBe("quiet_window");
		expect(typeof entry.durationMs).toBe("number");
		const tasks = (entry.metadata as { tasks?: Array<Record<string, unknown>> })
			?.tasks;
		expect(tasks).toEqual([
			{ name: "ok-task", durationMs: expect.any(Number), ok: true },
			{ name: "bad-task", durationMs: expect.any(Number), ok: false },
		]);

		spy.mockRestore();
	});

	describe("registerBuiltinQuietWindowTasks", () => {
		it("registers the cascade-settle and heartbeat tasks exactly once (idempotent)", async () => {
			const runtime = new RuntimeCoordinator();
			const settleSpy = vi.spyOn(runtime, "settleCascadeRuns");

			registerBuiltinQuietWindowTasks(() => runtime);
			registerBuiltinQuietWindowTasks(() => runtime); // second call must be a no-op

			await runQuietWindow({ runtime, dbg: vi.fn() });

			expect(settleSpy).toHaveBeenCalledTimes(1);
		});
	});
});
