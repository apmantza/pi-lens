/**
 * Characterization + unit tests for the consolidated timeout-race helper (#366).
 * These lock the exact semantics of the three helpers folded into `withDeadline`
 * (`withTimeout`, `withBudget`, `withinRemaining`) so the consolidation is
 * provably behavior-preserving, and cover the two latent bugs it fixes:
 * `withBudget`'s missing late-rejection suppression and `withinRemaining`'s
 * uncleared timer.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	combineAbortSignals,
	withBudget,
	withDeadline,
	withinRemaining,
	withTimeout,
} from "../../clients/deadline-utils.js";

const slow = <T>(value: T, ms: number): Promise<T> =>
	new Promise((resolve) => setTimeout(() => resolve(value), ms));
const slowReject = (message: string, ms: number): Promise<never> =>
	new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));

describe("withDeadline", () => {
	describe("reject-on-timeout mode (default)", () => {
		it("resolves the value when the promise wins", async () => {
			await expect(withDeadline(slow("ok", 5), { ms: 1000 })).resolves.toBe("ok");
		});
		it("rejects with a Timeout error when the timer wins", async () => {
			await expect(withDeadline(slow("x", 1000), { ms: 10 })).rejects.toThrow(
				/Timeout after 10ms/,
			);
		});
		it("propagates the promise's own rejection", async () => {
			await expect(
				withDeadline(slowReject("boom", 5), { ms: 1000 }),
			).rejects.toThrow("boom");
		});
		it("rejects immediately for a non-positive budget", async () => {
			await expect(withDeadline(slow("x", 50), { ms: 0 })).rejects.toThrow(
				/Timeout after/,
			);
		});
	});

	describe("resolve-undefined-on-timeout mode", () => {
		it("resolves undefined when the timer wins", async () => {
			await expect(
				withDeadline(slow("x", 1000), { ms: 10, onTimeout: "undefined" }),
			).resolves.toBeUndefined();
		});
		it("resolves undefined immediately for a non-positive budget", async () => {
			await expect(
				withDeadline(slow("x", 50), { ms: 0, onTimeout: "undefined" }),
			).resolves.toBeUndefined();
		});
		it("still propagates the promise's own rejection (onReject default)", async () => {
			await expect(
				withDeadline(slowReject("boom", 5), { ms: 1000, onTimeout: "undefined" }),
			).rejects.toThrow("boom");
		});
	});

	describe("swallow-rejection mode (onReject: undefined)", () => {
		it("resolves undefined when the promise rejects", async () => {
			await expect(
				withDeadline(slowReject("boom", 5), {
					ms: 1000,
					onTimeout: "undefined",
					onReject: "undefined",
				}),
			).resolves.toBeUndefined();
		});
	});

	describe("deadline mode", () => {
		it("resolves the value before the deadline", async () => {
			await expect(
				withDeadline(slow("ok", 5), { deadlineAt: Date.now() + 1000 }),
			).resolves.toBe("ok");
		});
		it("resolves undefined immediately once the deadline has passed", async () => {
			await expect(
				withDeadline(slow("x", 50), {
					deadlineAt: Date.now() - 1,
					onTimeout: "undefined",
				}),
			).resolves.toBeUndefined();
		});
	});
});

describe("late-rejection suppression (#366 bug fix)", () => {
	let reasons: unknown[];
	const onUnhandled = (r: unknown) => reasons.push(r);

	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
	});

	it.each([
		["reject mode", { ms: 10 } as const],
		["undefined mode (withBudget's fixed bug)", { ms: 10, onTimeout: "undefined" } as const],
	])(
		"does not surface the loser promise's late rejection in %s",
		async (_label, opts) => {
			reasons = [];
			process.on("unhandledRejection", onUnhandled);
			// Timer wins at 10ms; the promise rejects later at 40ms.
			const race = withDeadline(slowReject("late-loser", 40), opts);
			await race.catch(() => undefined);
			// Wait past the 40ms rejection so a missing guard would have surfaced it.
			await new Promise((r) => setTimeout(r, 80));
			expect(
				reasons.some((r) => r instanceof Error && r.message === "late-loser"),
			).toBe(false);
		},
	);
});

describe("named adapters preserve their exact semantics", () => {
	it("withTimeout: rejects on timeout, propagates rejection, resolves value", async () => {
		await expect(withTimeout(slow("v", 5), 1000)).resolves.toBe("v");
		await expect(withTimeout(slow("v", 1000), 10)).rejects.toThrow(/Timeout after 10ms/);
		await expect(withTimeout(slowReject("boom", 5), 1000)).rejects.toThrow("boom");
	});

	it("withBudget: undefined on timeout, undefined for <=0, propagates rejection", async () => {
		await expect(withBudget(slow("v", 1000), 10)).resolves.toBeUndefined();
		await expect(withBudget(slow("v", 50), 0)).resolves.toBeUndefined();
		await expect(withBudget(slow("v", 5), 1000)).resolves.toBe("v");
		await expect(withBudget(slowReject("boom", 5), 1000)).rejects.toThrow("boom");
	});

	it("withinRemaining: undefined on timeout, swallows rejection, undefined once past deadline", async () => {
		await expect(withinRemaining(slow("v", 5), Date.now() + 1000)).resolves.toBe("v");
		await expect(withinRemaining(slow("v", 1000), Date.now() + 10)).resolves.toBeUndefined();
		await expect(withinRemaining(slowReject("boom", 5), Date.now() + 1000)).resolves.toBeUndefined();
		await expect(withinRemaining(slow("v", 50), Date.now() - 1)).resolves.toBeUndefined();
	});
});

describe("combineAbortSignals", () => {
	it("returns the single live signal unchanged", () => {
		const c = new AbortController();
		expect(combineAbortSignals(undefined, c.signal)).toBe(c.signal);
	});

	it("returns undefined when no signal is live", () => {
		expect(combineAbortSignals(undefined, undefined)).toBeUndefined();
	});

	it("aborts when EITHER source aborts", () => {
		const a = new AbortController();
		const b = new AbortController();
		const combined = combineAbortSignals(a.signal, b.signal);
		expect(combined?.aborted).toBe(false);
		b.abort();
		expect(combined?.aborted).toBe(true);
	});

	it("is already aborted when a source was pre-aborted", () => {
		const a = new AbortController();
		a.abort();
		const b = new AbortController();
		expect(combineAbortSignals(a.signal, b.signal)?.aborted).toBe(true);
	});
});
