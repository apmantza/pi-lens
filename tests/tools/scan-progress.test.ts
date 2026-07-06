import { describe, expect, it, vi } from "vitest";
import {
	makeProgressReporter,
	renderScanProgress,
	scanningSummaryLine,
} from "../../tools/scan-progress.js";

describe("renderScanProgress", () => {
	it("renders counts + percentage with a full/empty bar", () => {
		expect(renderScanProgress(0, 100)).toContain("0/100 (0%)");
		expect(renderScanProgress(0, 100)).toContain("░░░░░░░░░░░░░░░░░░░░");
		const mid = renderScanProgress(50, 100);
		expect(mid).toContain("50/100 (50%)");
		expect(mid).toContain("██████████░░░░░░░░░░");
		expect(renderScanProgress(100, 100)).toContain("100/100 (100%)");
		expect(renderScanProgress(100, 100)).toContain("████████████████████");
	});

	it("is safe at total=0 and honors a custom label", () => {
		expect(renderScanProgress(0, 0)).toContain("0/0 (0%)");
		expect(
			renderScanProgress(1, 2, "Scanning LSP diagnostics").startsWith(
				"Scanning LSP diagnostics…",
			),
		).toBe(true);
	});
});

describe("scanningSummaryLine", () => {
	it("returns the joined content text (the bar) for a scanning partial", () => {
		const bar = "Scanning project diagnostics… [██░░] 5/10 (50%)";
		expect(scanningSummaryLine({ phase: "scanning" }, bar)).toBe(bar);
	});

	it("falls back to counts when the content text is empty", () => {
		expect(
			scanningSummaryLine({ phase: "scanning", completed: 3, total: 8 }, ""),
		).toBe("Scanning… 3/8");
	});

	it("returns null for a normal (non-progress) result so the caller falls through", () => {
		expect(scanningSummaryLine({ mode: "full", filesChecked: 40 }, "x")).toBeNull();
		expect(scanningSummaryLine(undefined, "x")).toBeNull();
		expect(scanningSummaryLine({ phase: "done" }, "x")).toBeNull();
	});
});

describe("makeProgressReporter", () => {
	it("returns undefined when there is no update callback", () => {
		expect(makeProgressReporter(undefined)).toBeUndefined();
		expect(makeProgressReporter(null)).toBeUndefined();
		expect(makeProgressReporter({})).toBeUndefined();
	});

	it("throttles intermediate ticks but always emits the final one", () => {
		const emitted: string[] = [];
		const onUpdate = vi.fn((u: { content: Array<{ text: string }> }) =>
			emitted.push(u.content[0]!.text),
		);
		const report = makeProgressReporter(onUpdate, undefined, 250)!;
		expect(report).toBeTypeOf("function");

		// First tick emits (lastEmit=0). The next few within the window are dropped.
		report(1, 10);
		report(2, 10);
		report(3, 10);
		expect(onUpdate).toHaveBeenCalledTimes(1);

		// The completed===total tick always emits, regardless of throttle.
		report(10, 10);
		expect(onUpdate).toHaveBeenCalledTimes(2);
		expect(emitted[1]).toContain("10/10 (100%)");
	});

	it("passes completed/total through details for programmatic consumers", () => {
		const onUpdate = vi.fn();
		makeProgressReporter(onUpdate)!(3, 7);
		expect(onUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				details: { phase: "scanning", completed: 3, total: 7 },
			}),
		);
	});
});
