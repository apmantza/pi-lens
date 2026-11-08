import { describe, expect, it } from "vitest";
import { withRealPi } from "../support/real-pi-harness.js";

// flake-shape: real-process-spawn — the report text is built by the real host's lens_diagnostics tool, which no in-process double reaches
//
// Recurrence prevented: #5287 (found by review r1 of #5285 on real pi): write
// `notes.zzz` (no file kind, so no check runs) and `lens_diagnostics mode=full`
// opened with "No issues across 1 file diagnosed this session. ✓", and so did
// mode=all, for a file whose own write line said it was unconfirmed. The store
// held the reason; `getFileDiagnosticSummaries` dropped it, so every cache-only
// report read "no findings" as "clean". Each row writes a file no check
// completed on and reads what the model is handed by the two reports.

const reportTexts = async (
	script: string,
): Promise<{ full: string; all: string }> =>
	withRealPi(
		{
			fixture: "unchecked-report",
			script,
			args: ["--no-lsp"],
			env: { PI_LENS_TEST_MODE: "0" },
		},
		async (pi) => {
			await pi.prompt("write the file, then read both reports");
			await pi.events("agent_end");
			const reports = pi
				.toolResults()
				.filter((event) => event.toolName === "lens_diagnostics")
				.map((event) => JSON.stringify(event.result));
			expect(reports, "one result per mode").toHaveLength(2);
			return { full: reports[0] as string, all: reports[1] as string };
		},
	);

describe("real pi: a file no check completed on is not a clean report (#5287)", () => {
	it.each([
		{
			name: "a file whose kind nothing can check",
			script: "script.json",
			file: "notes.zzz",
			reason: "no analyzer handles this file type",
			// `No issues` is the line this must not print; the file has no findings.
			noFindings: true,
		},
		{
			name: "a coverable kind with no primary checker under --no-lsp",
			script: "lua-modes.json",
			file: "a.lua",
			reason: "no primary checker is enabled for this kind",
			noFindings: true,
		},
		{
			// A file that holds findings still owes the line: its listing is not
			// a clean bill for the check that never ran.
			name: "a generated file that holds a project-scan finding",
			script: "generated-modes.json",
			file: "gen.ts",
			reason: "generated file",
			noFindings: false,
		},
	])(
		"$name is named as not checked in mode=full and mode=all",
		async (row) => {
			const { full, all } = await reportTexts(row.script);
			for (const [mode, text] of [
				["full", full],
				["all", all],
			] as const) {
				expect(text, mode).toContain("not checked");
				expect(text, mode).toContain(`${row.file}: `);
				expect(text, mode).toContain(row.reason);
				if (row.noFindings) {
					expect(text, mode).not.toContain("No issues");
					expect(text, mode).not.toContain("✓");
				}
			}
		},
		90_000,
	);
});
