import { describe, expect, it } from "vitest";
import { withRealPi } from "../support/real-pi-harness.js";

// flake-shape: real-process-spawn — the per-edit tool result is built by the real host's tool_result handler, which no in-process double reaches
//
// Recurrence prevented: #5258 (the 2026-11-04 clean-verdict probe): the write's
// tool result read `✓ JavaScript/TypeScript clean` for a TypeScript file with
// a type error under `--no-lsp`, and for a generated file with a type error,
// and a bare `✓ 14ms` for a file whose kind has no analyzer, because the
// all-clear line was the DEFAULT of a missing `unconfirmedStatus`, not the
// answer of a runner that completed. Each row writes a file that really holds
// an error and reads the line the host hands the model.

const writeResultText = async (
	script: string,
	args: readonly string[],
): Promise<string> =>
	withRealPi(
		{ fixture: "clean-verdict", script, args, env: { PI_LENS_TEST_MODE: "0" } },
		async (pi) => {
			await pi.prompt("write the file");
			const result = await pi.awaitToolResult("write");
			await pi.events("agent_end");
			return JSON.stringify(result);
		},
	);

describe("real pi: a write no check covered never reads clean (#5258)", () => {
	it.each([
		{
			name: "a TypeScript type error under --no-lsp",
			script: "script.json",
			args: ["--no-lsp"],
			reason:
				"no primary checker is enabled for this kind (--no-lsp turns off its language server)",
		},
		{
			name: "a type error in a generated file",
			script: "generated.json",
			args: ["--no-lsp"],
			reason: "generated file",
		},
		{
			name: "a build.gradle syntax error under --no-lsp",
			script: "gradle.json",
			args: ["--no-lsp"],
			reason:
				"no primary checker is enabled for this kind (--no-lsp turns off its language server)",
		},
		{
			name: "a file whose kind has no analyzer",
			script: "kindless.json",
			args: ["--no-lsp"],
			reason: "no analyzer handles this file type",
		},
	])(
		"$name renders an unchecked line that names its reason",
		async (row) => {
			const text = await writeResultText(row.script, row.args);
			expect(text).toContain("⚠");
			expect(text).toContain(row.reason);
			expect(text).not.toContain("✓");
		},
		60_000,
	);
});
