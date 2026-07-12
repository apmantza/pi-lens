import { describe, expect, it } from "vitest";
import { WriteOrderingGuard } from "../../clients/write-ordering-guard.js";

describe("WriteOrderingGuard", () => {
	it("always allows the first write for a key (nothing to compare against yet)", () => {
		const guard = new WriteOrderingGuard<string, number>();
		expect(guard.shouldWrite("a", 5)).toBe(true);
	});

	it("allows a write whose token advances the last-recorded token for that key", () => {
		const guard = new WriteOrderingGuard<string, number>();
		expect(guard.shouldWrite("a", 1)).toBe(true);
		expect(guard.shouldWrite("a", 2)).toBe(true);
	});

	it("allows a write whose token matches the last-recorded token (no false-positive drop on a tie)", () => {
		const guard = new WriteOrderingGuard<string, number>();
		expect(guard.shouldWrite("a", 2)).toBe(true);
		expect(guard.shouldWrite("a", 2)).toBe(true);
	});

	it("drops a write whose token is behind the last-recorded token for that key", () => {
		const guard = new WriteOrderingGuard<string, number>();
		expect(guard.shouldWrite("a", 5)).toBe(true);
		expect(guard.shouldWrite("a", 3)).toBe(false);
	});

	it("does not let a dropped (superseded) write regress the tracked token — a later write must still be compared against the winning token", () => {
		const guard = new WriteOrderingGuard<string, number>();
		expect(guard.shouldWrite("a", 5)).toBe(true);
		expect(guard.shouldWrite("a", 3)).toBe(false); // dropped
		expect(guard.shouldWrite("a", 4)).toBe(false); // still behind 5, dropped
		expect(guard.shouldWrite("a", 6)).toBe(true); // advances past 5
	});

	it("always allows a write with an undefined token, and does not affect ordering for later tokened writes", () => {
		const guard = new WriteOrderingGuard<string, number>();
		expect(guard.shouldWrite("a", 5)).toBe(true);
		expect(guard.shouldWrite("a", undefined)).toBe(true);
		// The undefined-token write must not have reset or advanced tracking —
		// a subsequent write still behind 5 is dropped.
		expect(guard.shouldWrite("a", 3)).toBe(false);
	});

	it("tracks ordering independently per key", () => {
		const guard = new WriteOrderingGuard<string, number>();
		expect(guard.shouldWrite("a", 5)).toBe(true);
		expect(guard.shouldWrite("b", 1)).toBe(true); // unrelated key, no prior entry
		expect(guard.shouldWrite("a", 3)).toBe(false);
		expect(guard.shouldWrite("b", 3)).toBe(true);
	});

	it("delete() clears tracked ordering for a single key without affecting others", () => {
		const guard = new WriteOrderingGuard<string, number>();
		guard.shouldWrite("a", 5);
		guard.shouldWrite("b", 5);
		guard.delete("a");
		expect(guard.shouldWrite("a", 1)).toBe(true); // treated as first write again
		expect(guard.shouldWrite("b", 1)).toBe(false); // still tracked, still behind 5
	});

	it("clear() resets tracked ordering for all keys", () => {
		const guard = new WriteOrderingGuard<string, number>();
		guard.shouldWrite("a", 5);
		guard.shouldWrite("b", 5);
		guard.clear();
		expect(guard.shouldWrite("a", 1)).toBe(true);
		expect(guard.shouldWrite("b", 1)).toBe(true);
	});
});
