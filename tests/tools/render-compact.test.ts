import { describe, expect, it } from "vitest";
import {
	baseName,
	finalizeToolResult,
	fullTextOf,
	MAX_RESULT_BYTES,
	renderToolResultContract,
	renderToolText,
	RESULT_FOOTER_RESERVE_BYTES,
	selectCompactText,
} from "../../tools/render-compact.js";

/** Independently measures the delivered payload bytes a footer reports: the
 * full rendered text minus the footer block the gate appended after it. */
function deliveredPayloadBytes(text: string): number {
	const footerStart = text.search(/\n\nresult (?:ok|error)\n/);
	return Buffer.byteLength(text.slice(0, footerStart), "utf8");
}

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
		const err = {
			content: [{ type: "text" as const, text: "boom" }],
			isError: true,
		};
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

	it("renders one stable result and usage contract", () => {
		const result = finalizeToolResult(
			renderToolText("result body", {
				diagnostics: [{ severity: "warning" }],
			}),
		);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("result ok");
		expect(text).toContain("diag severity=warning");
		expect(text).toMatch(
			/usage tokens=\d+ elapsed-ms=\d+ bytes=\d+ truncated=(?:true|false)/,
		);
		// Exactly one footer: re-finalizing an already-final result must not
		// append a second contract block (refs #2852 N4). `toContain` passed on
		// double-stamped text, so count the verdict lines instead.
		const footerCount = (source: string) =>
			(source.match(/^result (?:ok|error)$/gm) ?? []).length;
		expect(footerCount(text)).toBe(1);
		expect(
			footerCount(renderToolResultContract(result).content[0]?.text ?? ""),
		).toBe(1);
	});

	describe("delivered-byte reporting (refs #2800 item 7)", () => {
		it("stamps exact delivered payload bytes on a normal result", () => {
			const result = finalizeToolResult(
				renderToolText("measured body", { symbols: 1 }),
			);
			const text = result.content[0]?.text ?? "";
			const match = text.match(
				/usage tokens=\d+ elapsed-ms=\d+ bytes=(\d+) truncated=(true|false)$/,
			);
			expect(match, "footer with bytes= and truncated=").not.toBeNull();
			expect(match?.[2]).toBe("false");
			// The expected value is measured from the rendered text, not derived
			// from the production path's own computation.
			expect(Number(match?.[1])).toBe(deliveredPayloadBytes(text));
		});

		it("keeps an oversized delivered text (footer included) inside MAX_RESULT_BYTES", () => {
			const result = finalizeToolResult(
				renderToolText("x".repeat(MAX_RESULT_BYTES * 2)),
			);
			const text = result.content[0]?.text ?? "";
			expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
				MAX_RESULT_BYTES,
			);
			expect(text).toMatch(/truncated=true$/);
			expect(text).toContain("characters omitted");
			const delivered = Number(text.match(/bytes=(\d+)/)?.[1]);
			// bytes= describes the delivered payload, never the pre-bound input.
			expect(delivered).toBeLessThanOrEqual(MAX_RESULT_BYTES);
			expect(delivered).toBe(deliveredPayloadBytes(text));
		});

		it("keeps the error verdict and delivered bytes on an isError result", () => {
			const result = finalizeToolResult({
				...renderToolText("boom"),
				isError: true,
			});
			const text = result.content[0]?.text ?? "";
			expect(text).toMatch(
				/result error\nusage tokens=\d+ elapsed-ms=\d+ bytes=\d+ truncated=false$/,
			);
			expect(Number(text.match(/bytes=(\d+)/)?.[1])).toBe(
				deliveredPayloadBytes(text),
			);
		});

		it("reserves the footer's maximum size inside the result budget", () => {
			expect(RESULT_FOOTER_RESERVE_BYTES).toBeGreaterThan(0);
			expect(RESULT_FOOTER_RESERVE_BYTES).toBeLessThan(MAX_RESULT_BYTES);
		});

		it("bounds the footer's diag section so the reserve stays sound", () => {
			const diagnostics = Array.from({ length: 5_000 }, () => ({
				severity: "w".repeat(300),
			}));
			const result = finalizeToolResult(
				renderToolText("body", { diagnostics }),
			);
			const text = result.content[0]?.text ?? "";
			expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
				MAX_RESULT_BYTES,
			);
		});
	});
});
