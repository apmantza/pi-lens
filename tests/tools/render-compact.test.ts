import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
	baseName,
	finalizeToolResult,
	finalizeToolResultWithDelivery,
	fullTextOf,
	MAX_RESULT_BYTES,
	renderToolResultContract,
	renderToolText,
	RESULT_FOOTER_RESERVE_BYTES,
	RESULT_PAYLOAD_BUDGET_BYTES,
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
		it("keeps every boundary result within the byte budget for both verdicts", () => {
			for (const isError of [false, true]) {
				for (let length = 40_800; length <= 41_100; length++) {
					const result = finalizeToolResult({
						...renderToolText("x".repeat(length)),
						isError,
					});
					expect(
						Buffer.byteLength(result.content[0].text, "utf8"),
					).toBeLessThanOrEqual(MAX_RESULT_BYTES);
				}
			}
		});

		it("does not mistake a payload result line for the anchored footer", () => {
			const payload = `quoted transcript\n\nresult ok\nusage tokens=1 elapsed-ms=2 bytes=3 truncated=false\n${"x".repeat(38_000)}`;
			const result = finalizeToolResult(renderToolText(payload));
			const text = result.content[0].text;
			expect(text).toContain(payload);
			expect((text.match(/^result ok$/gm) ?? []).length).toBe(2);
			expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(38_016);
		});

		it("writes one complete-result log and leaves no orphan for one oversized result", () => {
			const listLogs = () =>
				fs.existsSync(process.env.PI_LENS_HOME as string)
					? fs
							.readdirSync(process.env.PI_LENS_HOME as string, {
								recursive: true,
							})
							.filter(
								(file) =>
									String(file).includes("tool-result-") &&
									String(file).endsWith(".log"),
							)
					: [];
			const before = listLogs();
			const result = finalizeToolResult(renderToolText("z".repeat(200_000)));
			expect(result.content[0].text).toMatch(/Full output: .*tool-result-/);
			expect(listLogs()).toHaveLength(before.length + 1);
		});
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

		it("bounds the joined text and reports joined bytes for multiple text blocks", () => {
			const result = finalizeToolResult({
				content: [
					{ type: "text" as const, text: "a".repeat(MAX_RESULT_BYTES * 2) },
					{ type: "text" as const, text: "b".repeat(MAX_RESULT_BYTES * 2) },
				],
				isError: false,
				details: {},
			});
			const text = fullTextOf(result);
			const delivered = Number(text.match(/bytes=(\d+)/)?.[1]);
			expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
				MAX_RESULT_BYTES,
			);
			expect(delivered).toBe(deliveredPayloadBytes(text));
			expect(text).toContain("characters omitted");
		});

		it("keeps a fitting stamped result untouched on re-entry and reports the footer's own figures", () => {
			const first = finalizeToolResultWithDelivery(
				renderToolText("y".repeat(MAX_RESULT_BYTES * 2)),
			);
			const firstText = first.result.content[0]?.text ?? "";
			expect(Buffer.byteLength(firstText, "utf8")).toBeLessThanOrEqual(
				MAX_RESULT_BYTES,
			);
			expect(first.truncated).toBe(true);
			// Second gate over the already-stamped result (refs #2852 N4): the
			// delivered text is kept as delivered and the figures are the kept
			// footer's own prior values (row 6) — never a footer-inclusive
			// re-measure and never a hard-coded `false` (round 2 F1).
			const second = finalizeToolResultWithDelivery(first.result);
			const secondText = second.result.content[0]?.text ?? "";
			expect(secondText).toBe(firstText);
			const footerCount = (source: string) =>
				(source.match(/^result (?:ok|error)$/gm) ?? []).length;
			expect(footerCount(secondText)).toBe(1);
			expect(second.deliveredBytes).toBe(first.deliveredBytes);
			expect(second.truncated).toBe(first.truncated);
			// The reported figure is the payload the text actually carries, not
			// the footer-inclusive total the pre-fix branch measured.
			expect(second.deliveredBytes).toBe(deliveredPayloadBytes(secondText));
		});

		it("bounds an oversized pre-stamped result on re-entry", () => {
			// A result stamped without the gate's bound (the direct
			// renderToolResultContract path): oversized payload plus footer.
			const preStamped = renderToolResultContract(
				renderToolText("x".repeat(MAX_RESULT_BYTES * 2)),
			);
			const preStampedBytes = Buffer.byteLength(fullTextOf(preStamped), "utf8");
			expect(preStampedBytes).toBeGreaterThan(MAX_RESULT_BYTES);
			// The gate must still bound it on re-entry: the pre-fix re-entry
			// branch returned before the bound and delivered the whole
			// pre-stamped text unbounded.
			const gated = finalizeToolResultWithDelivery(preStamped);
			const gatedText = fullTextOf(gated.result);
			expect(Buffer.byteLength(gatedText, "utf8")).toBeLessThanOrEqual(
				MAX_RESULT_BYTES,
			);
			const footerCount = (source: string) =>
				(source.match(/^result (?:ok|error)$/gm) ?? []).length;
			expect(footerCount(gatedText)).toBe(1);
			// The figures are the kept footer's own (row 6: prior value kept) —
			// the footer describes the payload as it was first stamped.
			const footer = gatedText.match(/bytes=(\d+) truncated=(true|false)$/);
			expect(footer, "kept footer figures").not.toBeNull();
			expect(gated.deliveredBytes).toBe(Number(footer?.[1]));
			expect(gated.truncated).toBe(footer?.[2] === "true");
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

		it("reserves the byte count of the footer's widest literal and covers a rendered worst case", () => {
			// Round 2 F2 pin: the reserve must equal the widest footer the
			// renderer can emit — the error verdict, a diag section at its 1 KiB
			// cap (separator included), 16-digit numeric fields
			// (Number.MAX_SAFE_INTEGER width), and the wider `truncated=false`.
			// Editing either side without the other reds here.
			const widest = `\n\nresult error\n${"x".repeat(1024)}\nusage tokens=${"9".repeat(16)} elapsed-ms=${"9".repeat(16)} bytes=${"9".repeat(16)} truncated=false`;
			expect(RESULT_FOOTER_RESERVE_BYTES).toBe(
				Buffer.byteLength(widest, "utf8"),
			);
			// Soundness through the real renderer: a result at the same maxima
			// (error verdict, diag section filled to the cap, 16-digit usage)
			// renders a footer no wider than the reserve. Four 215-byte diag
			// lines plus one 164-byte line fill the 1 KiB cap exactly.
			const diagnostics = [
				{ severity: "w".repeat(200) },
				{ severity: "w".repeat(200) },
				{ severity: "w".repeat(200) },
				{ severity: "w".repeat(200) },
				{ severity: "w".repeat(149) },
			];
			const worst = renderToolResultContract({
				content: [{ type: "text" as const, text: "payload" }],
				isError: true,
				usage: {
					tokens: Number.MAX_SAFE_INTEGER,
					elapsedMs: Number.MAX_SAFE_INTEGER,
				},
				details: { diagnostics },
			});
			const worstText = worst.content[0]?.text ?? "";
			const footerStart = worstText.search(/\n\nresult (?:ok|error)\n/);
			expect(footerStart, "footer in rendered worst case").toBeGreaterThan(-1);
			expect(RESULT_FOOTER_RESERVE_BYTES).toBeGreaterThanOrEqual(
				Buffer.byteLength(worstText.slice(footerStart), "utf8"),
			);
			// The payload budget is the result budget minus the reserve; the
			// round-1 M1 mutation (binding the payload at the full budget) reds
			// on this line.
			expect(RESULT_PAYLOAD_BUDGET_BYTES).toBe(
				MAX_RESULT_BYTES - RESULT_FOOTER_RESERVE_BYTES,
			);
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
