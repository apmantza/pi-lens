import { describe, expect, it } from "vitest";
import { withRealPi } from "../support/real-pi-harness.js";

// flake-shape: real-process-spawn — the per-edit tool result is built by the real host's tool_result handler, which no in-process double reaches
//
// Recurrence prevented: #5258 (the 2026-11-08 tool-alignment audit): a runner
// that skipped with no stated reason (119 bare `skipped` returns) made the
// write's notice say "a language tool is missing, timed out, or failed to run"
// for a file whose runner was simply not configured, and for one whose tool the
// install kill switch refused. Each row writes a markdown file with `--no-lsp`
// (primary group: spellcheck, vale; typos is absent and vale has no
// `.vale.ini`) and reads the text the host hands the model.

const writeResultText = async (env: Record<string, string>): Promise<string> =>
	withRealPi(
		{
			fixture: "skip-reason",
			script: "markdown.json",
			args: ["--no-lsp"],
			// An empty PATH tail hides host-installed typos / vale; the harness keeps
			// the repo bin and node's own directory ahead of it.
			env: { PI_LENS_TEST_MODE: "0", PATH: "/nonexistent-path-5258", ...env },
		},
		async (pi) => {
			await pi.prompt("write the file");
			const result = await pi.awaitToolResult("write");
			await pi.events("agent_end");
			return JSON.stringify(result);
		},
	);

describe("real pi: a skipped check names why the file was not checked (#5258)", () => {
	it("says which runner is not installed and which is not configured", async () => {
		const text = await writeResultText({});
		expect(text).toContain("spellcheck: not installed");
		expect(text).toContain("vale: not configured");
		expect(text).not.toContain("a language tool is missing, timed out");
		expect(text).not.toContain("✓");
	}, 60_000);

	it("names the install kill switch when it is what kept the tool away", async () => {
		const text = await writeResultText({ PI_LENS_DISABLE_TOOL_INSTALL: "1" });
		expect(text).toContain("spellcheck: not installed");
		expect(text).toContain("PI_LENS_DISABLE_TOOL_INSTALL=1");
		expect(text).toContain("vale: not configured");
		expect(text).not.toContain("✓");
	}, 60_000);
});
