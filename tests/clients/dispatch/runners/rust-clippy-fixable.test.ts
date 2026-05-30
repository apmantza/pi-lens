import { describe, expect, it } from "vitest";
import { parseClippyOutput } from "../../../../clients/dispatch/runners/rust-clippy.js";

function clippyMessage(
	code: string,
	message: string,
	level: "warning" | "error",
	spans: Array<{
		file?: string;
		file_name?: string;
		line_start?: number;
		column_start?: number;
		suggested_replacement?: string;
		suggestion_applicability?: string;
	}>,
): string {
	return JSON.stringify({
		reason: "compiler-message",
		message: {
			code: { code },
			message,
			level,
			spans,
		},
	});
}

describe("parseClippyOutput — fixable propagation (#112 slice)", () => {
	it("marks a diagnostic fixable when any span carries a MachineApplicable suggested_replacement", () => {
		const raw = clippyMessage(
			"needless_return",
			"unneeded return statement",
			"warning",
			[
				{
					file: "src/main.rs",
					line_start: 1,
					column_start: 1,
					suggested_replacement: "fn main() {}",
					suggestion_applicability: "MachineApplicable",
				},
			],
		);
		const diags = parseClippyOutput(raw, "src/main.rs");
		expect(diags).toHaveLength(1);
		expect(diags[0]).toMatchObject({
			tool: "rust-clippy",
			rule: "needless_return",
			defectClass: "correctness",
			fixable: true,
			fixSuggestion: "fn main() {}",
		});
	});

	it("does not mark fixable when applicability is MaybeIncorrect", () => {
		const raw = clippyMessage(
			"redundant_clone",
			"redundant clone",
			"warning",
			[
				{
					file: "src/main.rs",
					line_start: 5,
					column_start: 3,
					suggested_replacement: "x",
					suggestion_applicability: "MaybeIncorrect",
				},
			],
		);
		const diags = parseClippyOutput(raw, "src/main.rs");
		expect(diags).toHaveLength(1);
		expect(diags[0].fixable).toBe(false);
		expect(diags[0].fixSuggestion).toBeUndefined();
	});

	it("does not mark fixable when no suggested_replacement is present", () => {
		const raw = clippyMessage(
			"cognitive_complexity",
			"too complex",
			"warning",
			[{ file: "src/main.rs", line_start: 10, column_start: 1 }],
		);
		const diags = parseClippyOutput(raw, "src/main.rs");
		expect(diags).toHaveLength(1);
		expect(diags[0].fixable).toBe(false);
		expect(diags[0].fixSuggestion).toBeUndefined();
	});

	it("finds a MachineApplicable suggestion on a non-primary span", () => {
		// Clippy can attach the fix to a secondary span — e.g. when the
		// suggested fix touches both a use-site (primary) and removes an
		// import (secondary). The diagnostic should still be fixable.
		const raw = clippyMessage(
			"single_match",
			"single match could be a if let",
			"warning",
			[
				{ file: "src/main.rs", line_start: 10, column_start: 1 },
				{
					file: "src/main.rs",
					line_start: 1,
					column_start: 1,
					suggested_replacement: "use std::collections::HashMap;",
					suggestion_applicability: "MachineApplicable",
				},
			],
		);
		const diags = parseClippyOutput(raw, "src/main.rs");
		expect(diags).toHaveLength(1);
		expect(diags[0].fixable).toBe(true);
		expect(diags[0].fixSuggestion).toBe("use std::collections::HashMap;");
	});

	it("skips messages that are not compiler-message (e.g. build-script-executed lines)", () => {
		const raw = [
			JSON.stringify({ reason: "build-script-executed", package_id: "x" }),
			clippyMessage("needless_return", "unneeded return", "warning", [
				{
					file: "src/main.rs",
					line_start: 1,
					column_start: 1,
				},
			]),
			"not even json",
		].join("\n");
		const diags = parseClippyOutput(raw, "src/main.rs");
		expect(diags).toHaveLength(1);
		expect(diags[0].rule).toBe("needless_return");
	});
});
