/**
 * #2225 — the output-cap kill (`stopForOutputLimit`) and the timeout/abort
 * kill are two independent real-time races in `safe-spawn.ts`: whichever
 * fires first — a real child's stdout 'data' event, or a wall-clock
 * `setTimeout`/`AbortSignal` — decides `killedForOutputCap`. Driving that
 * race with an actual spawned child (as `safe-spawn-ambient-signal.test.ts`
 * originally did) makes the test itself timing-dependent: under CPU
 * starvation from other concurrent processes, Node's event loop runs its
 * timers phase before delivering already-arrived pipe data in the poll
 * phase, so a real 300ms timer can beat a child that already wrote its
 * capped output. Measured 5 of 8 concurrent vitest processes failing on
 * both master and an unrelated feature branch (#2225's evidence).
 *
 * This file removes the real-time race BY CONSTRUCTION: `node:child_process`
 * is mocked (the established `fake-child.ts` double, also used by
 * `safe-spawn-close-before-error-race.test.ts` and
 * `safe-spawn-windows-env-plumbing.test.ts`), so the "child wrote enough to
 * trip the cap" signal is a synchronous `EventEmitter.emit("data", ...)`
 * call the test issues itself — ordered relative to the timeout/abort
 * trigger by the test's own statement order, not by an OS scheduler. A
 * microtask flush always runs before a macrotask (Node/JS engine guarantee,
 * independent of machine load), so awaiting one microtask after the mocked
 * spawn call, before firing the timeout timer or the abort signal, makes the
 * cap-trips-first ordering deterministic rather than probable.
 *
 * `process.platform` is pinned to "linux" for the run (posixProcessGroup
 * path in `killTree`) so the kill goes through the mocked `process.kill`
 * directly, without a nested nested-`spawn()` `taskkill` call to also mock —
 * the Windows-only branch has its own dedicated coverage elsewhere
 * (`safe-spawn-windows-*.test.ts`) and isn't what this race is about.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeChild } from "../support/fake-child.js";
import {
	killedForOutputCap,
	truncatedByOutputCap,
} from "../../clients/spawn-output-cap.js";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
	spawnSync: () => ({ stdout: "", stderr: "", status: 0, error: undefined }),
}));

vi.mock("../../clients/resource-sampler.js", () => ({
	startSpawnUsageSampler: () => ({ stop: () => null }),
}));

vi.mock("../../clients/latency-logger.js", () => ({
	logLatency: () => {},
}));

const { safeSpawnAsync } = await import("../../clients/safe-spawn.js");

// A real absolute path so command resolution (Windows-only) never gets in
// the way — this run always pins to the POSIX branch anyway.
const REAL_ABSOLUTE_COMMAND = process.execPath;

describe("safeSpawnAsync sequences the output-cap kill before timeout/abort by construction (#2225)", () => {
	const realPlatform = process.platform;
	let killSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers();
		Object.defineProperty(process, "platform", {
			value: "linux",
			configurable: true,
		});
		// Never send a real signal to a real pid — `child.pid` below is a
		// fabricated number that could coincidentally name a live process.
		killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", {
			value: realPlatform,
			configurable: true,
		});
		killSpy.mockRestore();
		vi.useRealTimers();
		spawnMock.mockReset();
	});

	it("reports a capped run that then timed out as a timeout, not a truncation", async () => {
		const child = makeFakeChild(4242);
		spawnMock.mockImplementation(() => {
			queueMicrotask(() => {
				// Exceeds the 1024-byte cap in a single chunk — a synchronous JS
				// call, not a real child's OS-scheduled write, so there's no
				// window for the timer below to win a real race.
				child.stdout.emit("data", "x".repeat(4096));
			});
			return child;
		});

		const resultPromise = safeSpawnAsync(REAL_ABSOLUTE_COMMAND, ["-e", ""], {
			timeout: 300,
			maxOutputBytes: 1024,
		});

		// Flush the microtask queue: the data emit above runs and trips the
		// cap (killedForOutputCap = true) BEFORE the timer below is allowed
		// to advance at all — ordered by construction, not by wall time.
		await Promise.resolve();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(300);

		// The child ignores the cap's SIGTERM and lingers, mirroring the
		// SIGTERM-hardy children the real-process version of this test used —
		// `timedOut` still latches from the timer above while the process is
		// still alive.
		child.emit("exit", null, "SIGTERM");
		child.emit("close", null, "SIGTERM");

		const result = await resultPromise;

		expect(result.outputTruncated).toBe(true);
		expect(result.killedForOutputCap).toBe(true);
		expect(result.failure).toBe("timeout");
		expect(truncatedByOutputCap(result)).toBe(false);
		expect(killedForOutputCap(result)).toBe(false);
	});

	it("reports a capped run that was then aborted as an abort, not a truncation", async () => {
		const child = makeFakeChild(4242);
		spawnMock.mockImplementation(() => {
			queueMicrotask(() => {
				child.stdout.emit("data", "x".repeat(4096));
			});
			return child;
		});

		const controller = new AbortController();
		const resultPromise = safeSpawnAsync(REAL_ABSOLUTE_COMMAND, ["-e", ""], {
			timeout: 10_000,
			maxOutputBytes: 1024,
			signal: controller.signal,
		});

		// Same construction as above: let the cap trip first, THEN abort —
		// the test drives both steps directly, no race to win.
		await Promise.resolve();
		await Promise.resolve();
		controller.abort();

		child.emit("exit", null, "SIGTERM");
		child.emit("close", null, "SIGTERM");

		const result = await resultPromise;

		expect(result.outputTruncated).toBe(true);
		expect(result.killedForOutputCap).toBe(true);
		expect(result.failure).toBe("aborted");
		expect(truncatedByOutputCap(result)).toBe(false);
		expect(killedForOutputCap(result)).toBe(false);
	});
});
