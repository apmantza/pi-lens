import { describe, expect, it } from "vitest";
import {
	baseName,
	fullTextOf,
	selectCompactText,
} from "../../tools/render-compact.js";

describe("render-compact", () => {
	const result = {
		content: [
			{ type: "text" as const, text: "line one" },
			{ type: "image" as const },
			{ type: "text" as const, text: "line two\nline three" },
		],
		isError: false,
		details: { symbols: 3 },
	};

	it("fullTextOf joins text blocks and ignores non-text", () => {
		expect(fullTextOf(result)).toBe("line one\nline two\nline three");
	});

	it("expanded returns the full text with output style", () => {
		const out = selectCompactText(result, {}, true, () => "summary");
		expect(out).toEqual({
			text: "line one\nline two\nline three",
			style: "output",
		});
	});

	it("collapsed returns the summary in brand (blue) style", () => {
		const out = selectCompactText(
			result,
			{ path: "/a/b/c.ts" },
			false,
			({ details, args, lineCount }) =>
				`${baseName(args.path)} ${(details as { symbols: number }).symbols} symbols ${lineCount}L`,
		);
		expect(out).toEqual({ text: "c.ts 3 symbols 3L", style: "brand" });
	});

	it("errors render in error style for both views", () => {
		const err = { content: [{ type: "text" as const, text: "boom" }], isError: true };
		expect(selectCompactText(err, {}, true, () => "s").style).toBe("error");
		expect(selectCompactText(err, {}, false, () => "s").style).toBe("error");
	});

	it("a throwing summarizer falls back to the first line", () => {
		const out = selectCompactText(result, {}, false, () => {
			throw new Error("bad");
		});
		expect(out.text).toBe("line one");
	});

	it("baseName handles windows and posix separators", () => {
		expect(baseName("C:\\Users\\x\\foo.ts")).toBe("foo.ts");
		expect(baseName("/a/b/foo.ts")).toBe("foo.ts");
		expect(baseName("foo.ts")).toBe("foo.ts");
		expect(baseName(undefined)).toBe("");
	});
});
