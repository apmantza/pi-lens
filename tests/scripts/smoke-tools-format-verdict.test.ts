import { describe, expect, it } from "vitest";
import { classifyFormatRow } from "../../scripts/smoke-tools.mjs";

const fixture = {
	lang: "python",
	dir: "tests/fixtures/tool-smoke/python",
	file: "bad.py",
	formatter: "black",
};

describe("classifyFormatRow (#2767)", () => {
	it("skips a typed unavailable result even when success is true", () => {
		// Regression: formatFile's typed unavailable outcome must not become a
		// false formatting failure when the executable is absent on nightly.
		expect(
			classifyFormatRow(
				{
					success: true,
					changed: false,
					outcome: "unavailable",
					error: "Cannot spawn black: tool not found (spawn black ENOENT)",
				},
				fixture,
			),
		).toEqual({
			status: "skip",
			detail:
				"tool not installed (Cannot spawn black: tool not found (spawn black ENOENT))",
		});
	});

	it("passes a successful changed result", () => {
		expect(
			classifyFormatRow(
				{ success: true, changed: true, outcome: "formatted" },
				fixture,
			),
		).toEqual({ status: "pass", detail: "black reformatted the file" });
	});

	it("fails a successful unchanged reformat result", () => {
		expect(
			classifyFormatRow(
				{ success: true, changed: false, outcome: "unchanged" },
				fixture,
			),
		).toEqual({
			status: "fail",
			detail: "ran clean but left the mis-formatted file unchanged",
		});
	});

	it.each([
		[
			"ENOENT",
			"spawn black ENOENT",
			"skip",
			"tool not installed (spawn black ENOENT)",
		],
		[
			"other failure",
			"black exited with status 2",
			"fail",
			"formatter failed to run: black exited with status 2",
		],
	])(
		"classifies an unsuccessful result: %s",
		(_name, error, status, detail) => {
			expect(
				classifyFormatRow(
					{ success: false, changed: false, outcome: "failed", error },
					fixture,
				),
			).toEqual({ status, detail });
		},
	);

	it("passes preserve with no change", () => {
		expect(
			classifyFormatRow(
				{ success: true, changed: false, outcome: "skipped" },
				{ ...fixture, expect: "preserve" },
			),
		).toEqual({
			status: "pass",
			detail: "black preserved the unconfigured file",
		});
	});

	it("fails preserve when the formatter changes the file", () => {
		expect(
			classifyFormatRow(
				{ success: true, changed: true, outcome: "formatted" },
				{ ...fixture, expect: "preserve" },
			),
		).toEqual({
			status: "fail",
			detail:
				"black rewrote an unconfigured file with no detectable style (style-preserving refusal expected)",
		});
	});
});
