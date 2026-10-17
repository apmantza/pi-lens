import { afterEach, describe, expect, it, vi } from "vitest";
import { suspendAt, waitFor } from "./interleaving-kit.js";

// #4437: the kit's wall budgets are a backstop scaled by the knob CI sets
// (PI_LENS_TEST_TIMEOUT_SCALE, as bounded-pid-file-lock.test.ts reads it), and
// an exhausted wait names its caller. The awaited "event" is a Date.now()
// threshold, so the probe needs no raw timer; fake timers make the elapsed
// time exact.

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

async function rejection(
	promise: Promise<unknown>,
): Promise<Error | undefined> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error as Error;
	}
}

async function settle(promise: Promise<unknown>, advanceMs: number) {
	const outcome = rejection(promise);
	await vi.advanceTimersByTimeAsync(advanceMs);
	return outcome;
}

/** One frame between the test body and the kit, like `restoreSettled`. */
function waitForEventAt(
	eventAtMs: number,
	timeoutMs: number,
): Promise<boolean> {
	const start = Date.now();
	return waitFor(() => Date.now() - start >= eventAtMs, Boolean, { timeoutMs });
}

describe("waitFor budget scaling (#4437)", () => {
	it("stays green when the event lands past the unscaled budget but inside the scaled one", async () => {
		vi.useFakeTimers();
		vi.stubEnv("PI_LENS_TEST_TIMEOUT_SCALE", "3");
		const error = await settle(waitForEventAt(250, 100), 1000);
		expect(error).toBeUndefined();
	});

	it("reds past the scaled budget and names the caller, elapsed time and both budgets", async () => {
		vi.useFakeTimers();
		vi.stubEnv("PI_LENS_TEST_TIMEOUT_SCALE", "3");
		const error = await settle(waitForEventAt(500, 100), 1000);
		expect(error?.message).toMatch(/^waitFor exhausted after 300ms /);
		expect(error?.message).toContain("budget 300ms = 100ms x");
		expect(error?.message).toContain("PI_LENS_TEST_TIMEOUT_SCALE 3");
		expect(error?.message).toMatch(/at \S*interleaving-kit\.test\.ts:\d+:\d+/);
		expect(error?.message).not.toMatch(/at \S*interleaving-kit\.ts:/);
	});

	it("reports the measured elapsed time, which can overshoot the budget", async () => {
		vi.useFakeTimers();
		vi.stubEnv("PI_LENS_TEST_TIMEOUT_SCALE", "3");
		const error = await settle(
			waitFor(() => false, Boolean, { timeoutMs: 100, intervalMs: 70 }),
			1000,
		);
		expect(error?.message).toMatch(/^waitFor exhausted after 350ms /);
		expect(error?.message).toContain("budget 300ms = 100ms x");
	});

	it("keeps the unscaled budget when the knob is unset", async () => {
		vi.useFakeTimers();
		vi.stubEnv("PI_LENS_TEST_TIMEOUT_SCALE", undefined);
		const error = await settle(waitForEventAt(250, 100), 1000);
		expect(error?.message).toMatch(/^waitFor exhausted after 100ms /);
		expect(error?.message).toContain("budget 100ms = 100ms x");
	});

	it.each(["0", "-2", "abc", "Infinity", ""])(
		"ignores the invalid knob value %j",
		async (value) => {
			vi.useFakeTimers();
			vi.stubEnv("PI_LENS_TEST_TIMEOUT_SCALE", value);
			const error = await settle(waitForEventAt(250, 100), 1000);
			expect(error?.message).toMatch(/^waitFor exhausted after 100ms /);
		},
	);

	it("scales the default budget too", async () => {
		vi.useFakeTimers();
		vi.stubEnv("PI_LENS_TEST_TIMEOUT_SCALE", "3");
		const error = await settle(
			waitFor(() => false, Boolean),
			40_000,
		);
		expect(error?.message).toMatch(/^waitFor exhausted after 30000ms /);
		expect(error?.message).toContain("budget 30000ms = 10000ms x");
	});
});

describe("suspendAt admission budget scaling (#4437)", () => {
	function unadmittedSeam(admissionTimeoutMs: number) {
		const spy = { mockImplementation: vi.fn(), mockRestore: vi.fn() };
		const suspension = suspendAt(spy, undefined, { admissionTimeoutMs });
		return { suspension, outcome: rejection(suspension.admitted) };
	}

	it("scales the admission wait and names the caller", async () => {
		vi.useFakeTimers();
		vi.stubEnv("PI_LENS_TEST_TIMEOUT_SCALE", "3");
		const { suspension, outcome } = unadmittedSeam(100);
		await vi.advanceTimersByTimeAsync(250);
		expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe(
			"pending",
		);
		await vi.advanceTimersByTimeAsync(100);
		const error = await outcome;
		expect(error?.message).toMatch(
			/^suspendAt seam was not admitted within 300ms /,
		);
		expect(error?.message).toContain("budget 300ms = 100ms x");
		expect(error?.message).toMatch(/at \S*interleaving-kit\.test\.ts:\d+:\d+/);
		suspension.restore();
	});

	it("keeps the unscaled admission budget when the knob is unset", async () => {
		vi.useFakeTimers();
		vi.stubEnv("PI_LENS_TEST_TIMEOUT_SCALE", undefined);
		const { suspension, outcome } = unadmittedSeam(100);
		await vi.advanceTimersByTimeAsync(150);
		const error = await outcome;
		expect(error?.message).toMatch(
			/^suspendAt seam was not admitted within 100ms /,
		);
		suspension.restore();
	});
});
