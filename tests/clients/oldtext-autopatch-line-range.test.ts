import { describe, expect, it } from "vitest";
import {
	findUniqueMatchLineRange,
	normalizeOldTextForMatch,
} from "../../clients/oldtext-autopatch.js";

const file = [
	"export function add(a: number, b: number): number {", // line 1
	"\treturn a + b;", // line 2
	"}", // line 3
	"", // line 4
	"export function sub(a: number, b: number): number {", // line 5
	"\treturn a - b;", // line 6
	"}", // line 7
	"", // line 8
	"export function mul(a: number, b: number): number {", // line 9
	"\treturn a * b;", // line 10
	"}", // line 11
].join("\n");

describe("findUniqueMatchLineRange (#118 autopatch → synthetic-read bridge)", () => {
	const normalized = normalizeOldTextForMatch(file);

	it("returns the 1-indexed line range of a single-line unique match", () => {
		const range = findUniqueMatchLineRange(normalized, "\treturn a - b;");
		expect(range).toEqual({ startLine: 6, endLine: 6 });
	});

	it("returns the line range of a multi-line unique match", () => {
		const range = findUniqueMatchLineRange(
			normalized,
			"export function mul(a: number, b: number): number {\n\treturn a * b;\n}",
		);
		expect(range).toEqual({ startLine: 9, endLine: 11 });
	});

	it("returns undefined when the needle does not match", () => {
		const range = findUniqueMatchLineRange(normalized, "return a / b;");
		expect(range).toBeUndefined();
	});

	it("returns undefined when the needle matches more than once", () => {
		// `\treturn ` appears on lines 2, 6, 10 — ambiguous.
		const range = findUniqueMatchLineRange(normalized, "\treturn ");
		expect(range).toBeUndefined();
	});

	it("returns undefined for an empty needle", () => {
		expect(findUniqueMatchLineRange(normalized, "")).toBeUndefined();
	});

	it("tolerates CRLF in the needle by normalizing both sides", () => {
		const range = findUniqueMatchLineRange(
			normalized,
			"\treturn a + b;\r\n}",
		);
		expect(range).toEqual({ startLine: 2, endLine: 3 });
	});

	it("tolerates trailing whitespace in the needle (autopatch's normal input shape)", () => {
		const range = findUniqueMatchLineRange(
			normalized,
			"\treturn a * b;   ",
		);
		expect(range).toEqual({ startLine: 10, endLine: 10 });
	});

	it("locates a match on the very first line", () => {
		const range = findUniqueMatchLineRange(
			normalized,
			"export function add(a: number, b: number): number {",
		);
		expect(range).toEqual({ startLine: 1, endLine: 1 });
	});

	it("locates a match on the last line of the file", () => {
		// "}" appears on lines 3, 7, 11 — ambiguous. Use a unique multi-line
		// needle that anchors to the end of the file instead.
		const range = findUniqueMatchLineRange(
			normalized,
			"\treturn a * b;\n}",
		);
		expect(range).toEqual({ startLine: 10, endLine: 11 });
	});
});

describe("normalizeOldTextForMatch (#118)", () => {
	it("converts CRLF to LF", () => {
		expect(normalizeOldTextForMatch("a\r\nb\r\n")).toBe("a\nb\n");
	});

	it("trims trailing whitespace on every line", () => {
		expect(normalizeOldTextForMatch("a   \n\tb\t \n")).toBe("a\n\tb\n");
	});

	it("preserves leading indentation (important — autopatch operates on indentation)", () => {
		expect(normalizeOldTextForMatch("\t\tif (x) {")).toBe("\t\tif (x) {");
	});
});
