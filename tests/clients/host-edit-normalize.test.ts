import { describe, expect, it } from "vitest";
import {
	detectLineEnding,
	hostWouldApplyOldText,
	normalizeForFuzzyMatch,
	normalizeForGuardMatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "../../clients/host-edit-normalize.js";

// Non-ASCII inputs are built from code points so this test source stays
// pure-ASCII (and robust to editors/transports that rewrite literal glyphs).
const cp = (...codes: number[]) => String.fromCharCode(...codes);
const LSQUO = cp(0x2018);
const RSQUO = cp(0x2019);
const LDQUO = cp(0x201c);
const RDQUO = cp(0x201d);
const EMDASH = cp(0x2014);
const NBSP = cp(0x00a0);
const BOM = cp(0xfeff);

describe("host-edit-normalize: line-ending primitives", () => {
	it("detectLineEnding is first-occurrence-wins", () => {
		expect(detectLineEnding("a\r\nb\nc")).toBe("\r\n");
		expect(detectLineEnding("a\nb\r\nc")).toBe("\n");
		expect(detectLineEnding("no newline")).toBe("\n");
		expect(detectLineEnding("")).toBe("\n");
	});

	it("normalizeToLF collapses CRLF and lone CR", () => {
		expect(normalizeToLF("a\r\nb\rc\n")).toBe("a\nb\nc\n");
	});

	it("restoreLineEndings is the inverse for CRLF and a no-op for LF", () => {
		expect(restoreLineEndings("a\nb", "\r\n")).toBe("a\r\nb");
		expect(restoreLineEndings("a\nb", "\n")).toBe("a\nb");
	});
});

describe("host-edit-normalize: fuzzy fold", () => {
	it("folds smart quotes to ASCII", () => {
		expect(normalizeForFuzzyMatch(`${LSQUO}hi${RSQUO}`)).toBe("'hi'");
		expect(normalizeForFuzzyMatch(`${LDQUO}hi${RDQUO}`)).toBe('"hi"');
	});

	it("folds Unicode dashes and special spaces", () => {
		expect(normalizeForFuzzyMatch(`a ${EMDASH} b`)).toBe("a - b");
		expect(normalizeForFuzzyMatch(`a${NBSP}b`)).toBe("a b");
	});

	it("applies NFKC (full-width -> ASCII)", () => {
		// Full-width 'a' (U+FF41) and 'b' (U+FF42) fold to ASCII under NFKC.
		expect(normalizeForFuzzyMatch(cp(0xff41, 0xff42))).toBe("ab");
	});

	it("strips trailing whitespace per line", () => {
		expect(normalizeForFuzzyMatch("foo   \n\tbar\t \n")).toBe("foo\n\tbar\n");
	});

	it("preserves newline count (line numbers stay aligned)", () => {
		expect(
			normalizeForFuzzyMatch(`a${EMDASH}\nb \nc`).split("\n"),
		).toHaveLength(3);
	});

	it("is identity on plain ASCII source", () => {
		const src = "\tif (x) {\n\t\treturn 1;\n}";
		expect(normalizeForFuzzyMatch(src)).toBe(src);
	});
});

describe("host-edit-normalize: stripBom + composed guard match", () => {
	it("stripBom removes only a leading BOM", () => {
		expect(stripBom(`${BOM}hello`)).toEqual({ bom: BOM, text: "hello" });
		expect(stripBom("hello")).toEqual({ bom: "", text: "hello" });
	});

	it("normalizeForGuardMatch composes BOM -> LF -> fuzzy fold", () => {
		// A BOM + CRLF + smart-quote needle folds to the bare straight-quoted form.
		expect(
			normalizeForGuardMatch(`${BOM}const s = ${LSQUO}x${RSQUO};\r\n`),
		).toBe("const s = 'x';\n");
	});

	it("a smart-quoted needle matches straight-quoted file content (the #257 win)", () => {
		const file = "const greeting = 'hello world';\n";
		const needle = `const greeting = ${LSQUO}hello world${RSQUO};`;
		// Raw indexOf fails; guard-match-space indexOf succeeds, so the gate no
		// longer false-blocks an edit the host would apply.
		expect(file.includes(needle)).toBe(false);
		expect(
			normalizeForGuardMatch(file).includes(normalizeForGuardMatch(needle)),
		).toBe(true);
	});
});

describe("hostWouldApplyOldText (counterfactual)", () => {
	const file = "function add(a, b) {\n\treturn a + b;\n}\n";

	it("would apply a unique exact match", () => {
		expect(hostWouldApplyOldText(file, "\treturn a + b;")).toEqual({
			wouldApply: true,
			occurrences: 1,
			usedFuzzyMatch: false,
		});
	});

	it("would apply a unique fuzzy (smart-quote) match — flags a false-block", () => {
		const quoteFile = "const msg = 'hi';\n";
		const out = hostWouldApplyOldText(
			quoteFile,
			`const msg = ${LSQUO}hi${RSQUO};`,
		);
		expect(out.wouldApply).toBe(true);
		expect(out.usedFuzzyMatch).toBe(true);
		expect(out.occurrences).toBe(1);
	});

	it("would NOT apply an ambiguous (duplicate) match — host rejects too", () => {
		const dup = "x = 1;\nx = 1;\n";
		expect(hostWouldApplyOldText(dup, "x = 1;")).toEqual({
			wouldApply: false,
			occurrences: 2,
			usedFuzzyMatch: false,
		});
	});

	it("would NOT apply a genuine miss — confirms a legit block", () => {
		const out = hostWouldApplyOldText(file, "\treturn a - b;");
		expect(out.wouldApply).toBe(false);
		expect(out.occurrences).toBe(0);
	});

	it("would NOT apply an empty oldText", () => {
		expect(hostWouldApplyOldText(file, "")).toEqual({
			wouldApply: false,
			occurrences: 0,
			usedFuzzyMatch: false,
		});
	});

	it("matches across CRLF / BOM differences the way the host does", () => {
		const bomCrlf = `${BOM}function add(a, b) {\r\n\treturn a + b;\r\n}\r\n`;
		expect(hostWouldApplyOldText(bomCrlf, "\treturn a + b;").wouldApply).toBe(
			true,
		);
	});
});
