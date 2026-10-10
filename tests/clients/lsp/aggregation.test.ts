/**
 * Unit tests for raceToCompletion aggregation utility.
 * Verifies core racing logic independent of the LSP service layer.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { raceToCompletion } from "../../../clients/lsp/aggregation.js";

describe("raceToCompletion", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves immediately when first result satisfies shouldComplete and graceMs=0", async () => {
		const fast = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "a", count: 1 }), 50),
		);
		const slow = new Promise<{ id: string; count: number }>(() => {});

		const resultPromise = raceToCompletion(
			[fast, slow],
			(results) => results.some((r) => r.count > 0),
			{ timeoutMs: 1500, graceMs: 0 },
		);

		await vi.advanceTimersByTimeAsync(50);
		await vi.advanceTimersByTimeAsync(1);

		const result = await resultPromise;
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("a");
	});

	it("collects both results when second finishes before grace window expires", async () => {
		const fast = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "a", count: 1 }), 50),
		);
		const slow = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "b", count: 1 }), 200),
		);

		const resultPromise = raceToCompletion(
			[fast, slow],
			(results) => results.some((r) => r.count > 0),
			{ timeoutMs: 1500, graceMs: 400 },
		);

		// Fast resolves at 50ms, starts grace (400ms). Slow resolves at 200ms,
		// before grace expires → remaining=0 → finalize immediately at 200ms.
		await vi.advanceTimersByTimeAsync(200);
		await vi.advanceTimersByTimeAsync(1);

		const result = await resultPromise;
		expect(result).toHaveLength(2);
	});

	it("does NOT finalize when first result is empty", async () => {
		const empty = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "a", count: 0 }), 50),
		);
		const real = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "b", count: 3 }), 300),
		);

		const resultPromise = raceToCompletion(
			[empty, real],
			(results) => results.some((r) => r.count > 0),
			{ timeoutMs: 1500, graceMs: 0 },
		);

		// Empty resolves at 50ms — shouldComplete=false → keep waiting.
		await vi.advanceTimersByTimeAsync(50);
		await vi.advanceTimersByTimeAsync(1);

		let resolved = false;
		void resultPromise.then(() => {
			resolved = true;
		});
		await vi.advanceTimersByTimeAsync(1);
		expect(resolved).toBe(false);

		// Real resolves at 300ms.
		await vi.advanceTimersByTimeAsync(250);
		await vi.advanceTimersByTimeAsync(1);

		const result = await resultPromise;
		expect(result).toHaveLength(2);
		expect(result.map((r) => r.count)).toContain(3);
	});

	it("resolves via timeout when no results arrive", async () => {
		const hung = new Promise<{ id: string }>(() => {});

		const resultPromise = raceToCompletion(
			[hung, hung],
			(results) => results.length > 0,
			{ timeoutMs: 1500, graceMs: 0 },
		);

		await vi.advanceTimersByTimeAsync(1600);

		const result = await resultPromise;
		expect(result).toHaveLength(0);
	});
});

// #1458 S2: PromiseDescriptor.budgetMs caps the aux-grace window at
// min(auxGraceMs ceiling, max(budgetMs of still-pending auxiliaries)) —
// the same declared-budget-capped-by-ceiling shape touchFile's per-server
// aux wait uses, extended to the shared raceToCompletion timer.
describe("raceToCompletion — auxiliary budgetMs (#1458 S2)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shortens the aux-grace window to a declared budget below the ceiling", async () => {
		const primary = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "primary", count: 1 }), 100),
		);
		// Declared budget (300ms) is well under the 2000ms ceiling — the window
		// must be capped at ~300ms, not stretched to the ceiling.
		const aux = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "aux", count: 1 }), 5000),
		);

		const resultPromise = raceToCompletion(
			[primary, aux],
			(results) => results.some((r) => r.count > 0),
			{
				timeoutMs: 10000,
				graceMs: 0,
				descriptors: [
					{ role: "language" },
					{ role: "auxiliary", budgetMs: 300 },
				],
				auxGraceMs: 2000,
			},
		);

		await vi.advanceTimersByTimeAsync(100); // primary settles
		await vi.advanceTimersByTimeAsync(300); // declared budget elapses
		await vi.advanceTimersByTimeAsync(10);

		const result = await resultPromise;
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("primary");
	});

	it("caps a declared budget above the ceiling at the ceiling", async () => {
		const primary = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "primary", count: 1 }), 100),
		);
		// Declared budget (3500ms, e.g. opengrep cold-start) exceeds the 2000ms
		// ceiling — the window must be capped at the ceiling, not the budget.
		const aux = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "aux", count: 1 }), 3500),
		);

		const resultPromise = raceToCompletion(
			[primary, aux],
			(results) => results.some((r) => r.count > 0),
			{
				timeoutMs: 10000,
				graceMs: 0,
				descriptors: [
					{ role: "language" },
					{ role: "auxiliary", budgetMs: 3500 },
				],
				auxGraceMs: 2000,
			},
		);

		await vi.advanceTimersByTimeAsync(100); // primary settles
		await vi.advanceTimersByTimeAsync(2000); // ceiling elapses; aux still pending
		await vi.advanceTimersByTimeAsync(10);

		const result = await resultPromise;
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("primary");
	});

	it("admits a declared budget within the ceiling that beats a flat short default", async () => {
		const primary = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "primary", count: 1 }), 100),
		);
		// Warm-run aux answers at 1300ms — within its declared 1800ms budget and
		// the 2000ms ceiling, but past a flat 500ms default grace.
		const aux = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "aux", count: 1 }), 1300),
		);

		const resultPromise = raceToCompletion(
			[primary, aux],
			(results) => results.some((r) => r.count > 0),
			{
				timeoutMs: 10000,
				graceMs: 0,
				descriptors: [
					{ role: "language" },
					{ role: "auxiliary", budgetMs: 1800 },
				],
				auxGraceMs: 2000,
			},
		);

		await vi.advanceTimersByTimeAsync(1300);
		await vi.advanceTimersByTimeAsync(10);

		const result = await resultPromise;
		expect(result).toHaveLength(2);
		expect(result.map((r) => r.id).sort()).toEqual(["aux", "primary"]);
	});

	it("without budgetMs, keeps the flat ceiling as the window (back-compat)", async () => {
		const primary = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "primary", count: 1 }), 100),
		);
		// Aux resolves well past primary-settle(100) + ceiling(500) = 600, with
		// margin so it isn't racing the grace timer within the same tick.
		const aux = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "aux", count: 1 }), 900),
		);

		const resultPromise = raceToCompletion(
			[primary, aux],
			(results) => results.some((r) => r.count > 0),
			{
				timeoutMs: 10000,
				graceMs: 0,
				// No budgetMs on the auxiliary descriptor — flat 500ms applies.
				descriptors: [{ role: "language" }, { role: "auxiliary" }],
				auxGraceMs: 500,
			},
		);

		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(500);
		await vi.advanceTimersByTimeAsync(10);

		const result = await resultPromise;
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("primary");
	});
});
