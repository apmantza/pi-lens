import { describe, expect, it, vi } from "vitest";
import { retryWithBackoff } from "../../scripts/lib/retry.mjs";

const noopSleep = async () => {};

describe("retryWithBackoff (#2613 review S3a)", () => {
	it("returns ok on the first successful attempt without retrying", async () => {
		const attemptFn = vi.fn(async () => ({ ok: true as const, value: "v1" }));
		const result = await retryWithBackoff(attemptFn, { sleep: noopSleep });
		expect(result).toEqual({ ok: true, value: "v1", attempt: 0 });
		expect(attemptFn).toHaveBeenCalledTimes(1);
	});

	it("retries a failing attempt and succeeds on a later one", async () => {
		let calls = 0;
		const attemptFn = vi.fn(async () => {
			calls += 1;
			return calls < 3
				? { ok: false as const, reason: `attempt ${calls} failed` }
				: { ok: true as const, value: "v3" };
		});
		const result = await retryWithBackoff(attemptFn, { sleep: noopSleep });
		expect(result).toEqual({ ok: true, value: "v3", attempt: 2 });
		expect(attemptFn).toHaveBeenCalledTimes(3);
	});

	it("exhausts after `attempts` failures and reports every reason, never retrying a 4th time", async () => {
		const attemptFn = vi.fn(async (attempt: number) => ({
			ok: false as const,
			reason: `fail ${attempt}`,
		}));
		const result = await retryWithBackoff(attemptFn, {
			attempts: 3,
			sleep: noopSleep,
		});
		expect(result).toEqual({
			ok: false,
			reasons: ["fail 0", "fail 1", "fail 2"],
		});
		expect(attemptFn).toHaveBeenCalledTimes(3);
	});

	it("sleeps before every retry except the first attempt, using the configured backoff schedule", async () => {
		const sleep = vi.fn(async () => {});
		const attemptFn = vi.fn(async () => ({ ok: false as const, reason: "x" }));
		await retryWithBackoff(attemptFn, {
			attempts: 3,
			backoffMs: [0, 111, 222],
			sleep,
		});
		// Mutation-proof (dangerous direction): a backoff schedule that never
		// sleeps still "works" functionally but silently removes the delay a
		// registry-throttling remedy depends on -- pin the exact calls.
		expect(sleep.mock.calls).toEqual([[111], [222]]);
	});
});
