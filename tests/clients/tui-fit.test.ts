import { describe, expect, it } from "vitest";
import { visibleWidth } from "../../clients/deps/pi-tui.js";
import { fitLine, fitLines } from "../../clients/tui-fit.js";

// #513: pi-tui hard-crashes the host on over-width rendered lines; fitLine /
// fitLines are the shared guard (footer widget + turn-summary renderer).
describe("tui-fit (#513)", () => {
	it("fitLine truncates over-width text to at most maxWidth", () => {
		const long = "x".repeat(200);
		const out = fitLine(long, 40);
		expect(visibleWidth(out)).toBeLessThanOrEqual(40);
	});

	it("fitLine leaves text within the width untouched", () => {
		expect(fitLine("short", 40)).toBe("short");
	});

	it("fitLine is ANSI-aware — styled text is measured by visible width", () => {
		const styled = `\x1b[38;5;109m${"y".repeat(200)}\x1b[39m`;
		const out = fitLine(styled, 40);
		expect(visibleWidth(out)).toBeLessThanOrEqual(40);
	});

	it("fitLines truncates every line", () => {
		const out = fitLines(["a".repeat(100), "b", "c".repeat(300)], 25);
		expect(out).toHaveLength(3);
		for (const line of out) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(25);
		}
	});

	it("fitLines passes lines through on non-positive or non-finite width", () => {
		const lines = ["a".repeat(100), "b"];
		expect(fitLines(lines, 0)).toEqual(lines);
		expect(fitLines(lines, -5)).toEqual(lines);
		expect(fitLines(lines, Number.NaN)).toEqual(lines);
	});
});
