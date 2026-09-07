import { describe, expect, it } from "vitest";
import {
	normalizeForLedger,
	truncateForLedger,
} from "../../clients/ledger-bounds.js";

// oxlint type-aware `no-base-to-string` (2026-09-07): `String(value)` on a
// plain object writes "[object Object]" into a ledger field, which is a row
// that names nothing. Objects and arrays serialise; everything with its own
// `toString` (Error, Date, URL, primitives) keeps the String() form.
describe("normalizeForLedger", () => {
	it("serialises a plain object instead of writing [object Object]", () => {
		expect(normalizeForLedger({ code: "ENOENT", path: "/x" })).toBe(
			'{"code":"ENOENT","path":"/x"}',
		);
	});

	it("serialises an array", () => {
		expect(normalizeForLedger([1, "a"])).toBe('[1,"a"]');
	});

	it("keeps an Error's own string form", () => {
		expect(normalizeForLedger(new Error("boom"))).toBe("Error: boom");
	});

	it("keeps primitives, including falsy ones", () => {
		expect(normalizeForLedger(0)).toBe("0");
		expect(normalizeForLedger(false)).toBe("false");
		expect(normalizeForLedger("")).toBe("");
	});

	it("writes unknown for null and undefined", () => {
		expect(normalizeForLedger(null)).toBe("unknown");
		expect(normalizeForLedger(undefined)).toBe("unknown");
	});

	it("does not throw on a circular object", () => {
		const a: { self?: unknown } = {};
		a.self = a;
		expect(normalizeForLedger(a)).toBe("[unserializable object]");
	});

	it("truncates the serialised form like any other text", () => {
		const long = { k: "x".repeat(5000) };
		expect(truncateForLedger(long).endsWith("…")).toBe(true);
	});
});
