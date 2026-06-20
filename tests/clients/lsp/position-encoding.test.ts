/**
 * #269 — position-encoding negotiation core. Verifies we pick the server's
 * encoding correctly and translate UTF-16 character offsets to UTF-8 (byte) and
 * UTF-32 (code-point) offsets using the line text. UTF-16 must be the identity.
 */

import { describe, expect, it } from "vitest";
import {
	ADVERTISED_POSITION_ENCODINGS,
	convertCharacterOffset,
	lineTextAt,
	negotiatePositionEncoding,
} from "../../../clients/lsp/position-encoding.js";

describe("negotiatePositionEncoding (#269)", () => {
	it("returns the server's advertised encoding", () => {
		expect(negotiatePositionEncoding({ positionEncoding: "utf-8" })).toBe("utf-8");
		expect(negotiatePositionEncoding({ positionEncoding: "utf-16" })).toBe(
			"utf-16",
		);
		expect(negotiatePositionEncoding({ positionEncoding: "utf-32" })).toBe(
			"utf-32",
		);
	});

	it("defaults to utf-16 when absent, null, or unrecognised", () => {
		expect(negotiatePositionEncoding(undefined)).toBe("utf-16");
		expect(negotiatePositionEncoding(null)).toBe("utf-16");
		expect(negotiatePositionEncoding({})).toBe("utf-16");
		expect(negotiatePositionEncoding({ positionEncoding: "latin1" })).toBe(
			"utf-16",
		);
	});

	it("advertises utf-16 first (preserve the historical default)", () => {
		expect(ADVERTISED_POSITION_ENCODINGS[0]).toBe("utf-16");
		expect(ADVERTISED_POSITION_ENCODINGS).toContain("utf-8");
	});
});

describe("convertCharacterOffset (#269)", () => {
	it("is the identity for utf-16", () => {
		expect(convertCharacterOffset("utf-16", "café", 4)).toBe(4);
		expect(convertCharacterOffset("utf-16", "a😀b", 3)).toBe(3);
	});

	it("converts utf-16 offsets to utf-8 byte offsets across a multibyte glyph", () => {
		// "café": é is 1 UTF-16 unit but 2 UTF-8 bytes.
		expect(convertCharacterOffset("utf-8", "café", 3)).toBe(3); // before é
		expect(convertCharacterOffset("utf-8", "café", 4)).toBe(5); // after é
		// ASCII-only is unchanged.
		expect(convertCharacterOffset("utf-8", "const x = 1", 6)).toBe(6);
	});

	it("handles surrogate pairs for utf-8 (emoji = 2 UTF-16 units, 4 bytes)", () => {
		// "a😀b": offset of 'b' is 3 in UTF-16, 5 in UTF-8.
		expect(convertCharacterOffset("utf-8", "a😀b", 3)).toBe(5);
	});

	it("converts to utf-32 code-point offsets", () => {
		// "a😀b": 'b' is at UTF-16 offset 3 but code-point offset 2.
		expect(convertCharacterOffset("utf-32", "a😀b", 3)).toBe(2);
	});

	it("clamps an offset past the end of the line and floors at zero", () => {
		expect(convertCharacterOffset("utf-8", "café", 99)).toBe(5); // whole line
		expect(convertCharacterOffset("utf-8", "café", 0)).toBe(0);
		expect(convertCharacterOffset("utf-8", "café", -3)).toBe(0);
	});
});

describe("lineTextAt (#269)", () => {
	it("returns the 0-based line text", () => {
		const content = "first\nsecond\nthird";
		expect(lineTextAt(content, 0)).toBe("first");
		expect(lineTextAt(content, 1)).toBe("second");
		expect(lineTextAt(content, 2)).toBe("third");
	});

	it("returns empty string for out-of-range lines", () => {
		expect(lineTextAt("only", 5)).toBe("");
		expect(lineTextAt("only", -1)).toBe("");
	});
});
