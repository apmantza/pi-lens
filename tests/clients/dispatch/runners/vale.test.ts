/**
 * #1933 review F1: `parseValeOutput` used to assume a
 * `{ Data: { Files: [...] } }` envelope. No real `vale` binary has ever
 * emitted that shape (AGENTS.md defect shape 16 -- an unverified claim
 * about a tool's output, never checked against a real run). A real
 * `vale --output JSON` v3.9.6 run instead emits a flat map keyed by the
 * linted file's path, each value an array of alert objects with no
 * separate "Column" field (the column lives in `Span[0]`).
 *
 * Fixtures below are captured verbatim from real `vale --output JSON`
 * v3.9.6 runs (Windows binary, pinned release, sha256-verified against
 * this PR's .github/workflows/lint.yml pin) against this repo's own
 * AGENTS.md (warning/suggestion severities) and a scratch two-em-dash
 * sample linted with Google.EmDash enabled (error severity) -- not
 * hand-written. Trimmed to a few representative alerts; every field is
 * real.
 *
 * Pre-fix, `parsed?.Data?.Files` was always undefined against this real
 * shape, so `parseValeOutput` silently returned zero diagnostics no
 * matter how many real findings -- including error-severity ones -- the
 * binary actually reported. Imports the REAL `parseValeOutput` from the
 * compiled runner, not a private copy, so this can't silently drift from
 * the shipped parser (the #1791 biome-check.test.ts precedent).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { parseValeOutput } from "../../../../clients/dispatch/runners/vale.js";
import valeRunner from "../../../../clients/dispatch/runners/vale.js";
import { setupTestEnvironment } from "../../test-utils.js";

// Process boundary only: `vale` is not on the CI image, so every spawn
// (the availability probe and the run) answers a clean exit.
const safeSpawnAsync = vi.hoisted(() =>
	vi.fn(async (..._args: unknown[]) => ({
		error: null,
		status: 0,
		stdout: "{}",
		stderr: "",
	})),
);
vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawnAsync,
}));
// Captured from: vale --output=JSON AGENTS.md (v3.9.6, this repo's own
// .vale.ini), trimmed to one warning-severity and one suggestion-severity
// alert.
const REAL_WARNING_SUGGESTION_OUTPUT = JSON.stringify({
	"AGENTS.md": [
		{
			Action: { Name: "", Params: null },
			Span: [3, 25],
			Check: "Google.Headings",
			Description: "",
			Link: "https://developers.google.com/style/capitalization#capitalization-in-titles-and-headings",
			Message:
				"'pi-lens — agent context' should use sentence-style capitalization.",
			Severity: "warning",
			Match: "pi-lens — agent context",
			Line: 1,
		},
		{
			Action: { Name: "", Params: null },
			Span: [36, 39],
			Check: "Google.ExcessiveClaims",
			Description: "",
			Link: "https://developers.google.com/style/excessive-claims",
			Message: "Avoid the unverifiable claim 'best'.",
			Severity: "suggestion",
			Match: "best",
			Line: 129,
		},
	],
});

// Captured from: vale --output=JSON sample.md against a scratch two-em-dash
// paragraph, with Google.EmDash (error severity) enabled via a throwaway
// .vale.ini. Confirms the parser reaches a real error-severity alert, which
// is what the runner needs to ever report `status: "failed"`.
const REAL_ERROR_OUTPUT = JSON.stringify({
	"sample.md": [
		{
			Action: { Name: "edit", Params: ["trim", " "] },
			Span: [26, 28],
			Check: "Google.EmDash",
			Description: "",
			Link: "https://developers.google.com/style/dashes",
			Message: "Don't put a space before or after a dash.",
			Severity: "error",
			Match: " — ",
			Line: 3,
		},
	],
});

describe("vale parseValeOutput (real binary shape, #1933 review F1)", () => {
	it("parses a real warning-severity alert from the flat-map shape", () => {
		const diagnostics =
			parseValeOutput(REAL_WARNING_SUGGESTION_OUTPUT, "AGENTS.md", ".") ?? [];

		// Pre-fix: this was always [] -- `Data.Files` never existed on real
		// output, so a real vale run always parsed to zero diagnostics.
		expect(diagnostics.length).toBe(2);

		const heading = diagnostics.find((d) => d.rule === "Google.Headings");
		expect(heading).toBeDefined();
		expect(heading?.severity).toBe("warning");
		expect(heading?.line).toBe(1);
		// Column comes from Span[0]; real output has no "Column" field.
		expect(heading?.column).toBe(3);
		expect(heading?.message).toContain("sentence-style capitalization");
	});

	it("parses a real suggestion-severity alert and maps it to 'info'", () => {
		const diagnostics =
			parseValeOutput(REAL_WARNING_SUGGESTION_OUTPUT, "AGENTS.md", ".") ?? [];

		const claim = diagnostics.find((d) => d.rule === "Google.ExcessiveClaims");
		expect(claim).toBeDefined();
		expect(claim?.severity).toBe("info");
		expect(claim?.semantic).toBe("warning");
	});

	it("parses a real error-severity alert and marks it blocking", () => {
		const diagnostics =
			parseValeOutput(REAL_ERROR_OUTPUT, "sample.md", ".") ?? [];

		// Pre-fix: this was also always [] -- the exact defect the reviewer
		// flagged: a real vale run with real errors silently read as
		// "succeeded, 0 findings" because the top-level shape never matched.
		expect(diagnostics.length).toBe(1);
		expect(diagnostics[0].severity).toBe("error");
		expect(diagnostics[0].semantic).toBe("blocking");
		expect(diagnostics[0].rule).toBe("Google.EmDash");
		expect(diagnostics[0].column).toBe(26);
	});

	// #5411: `null` is output that is not a vale report; `[]` is a report read.
	it("tells an empty report from output that is not a report", () => {
		expect(parseValeOutput("", "AGENTS.md", ".")).toEqual([]);
		expect(parseValeOutput("not json", "AGENTS.md", ".")).toBe(null);
		expect(parseValeOutput("[]", "AGENTS.md", ".")).toBe(null);
		// An empty flat map (vale ran, found nothing) is a real, valid shape.
		expect(parseValeOutput("{}", "AGENTS.md", ".")).toEqual([]);
	});
});

describe("vale config lookup (#4689 item 6)", () => {
	it("runs when .vale.ini sits at the runner's own cwd", async () => {
		// RECURRENCE GUARDED: `findValeConfig` lost its explicit `cwd/.vale.ini`
		// pre-check when it folded onto `findLocalToolConfig`; a lookup that
		// started at the cwd's parent would skip every project whose config is
		// in the project root, silently turning Vale off.
		const env = setupTestEnvironment("pi-lens-vale-config-");
		try {
			fs.writeFileSync(
				path.join(env.tmpDir, ".vale.ini"),
				"MinAlertLevel = suggestion\n",
			);
			const filePath = path.join(env.tmpDir, "doc.md");
			fs.writeFileSync(filePath, "# Doc\n");
			safeSpawnAsync.mockClear();
			const result = await valeRunner.run({
				filePath,
				cwd: env.tmpDir,
				kind: "markdown",
				pi: { getFlag: () => false },
				autofix: false,
				deltaMode: true,
				facts: new FactStore(),
				hasTool: async () => true,
				log: () => {},
			} as never);
			expect({
				skipped: result.status === "skipped",
				ranVale: safeSpawnAsync.mock.calls.some((call) =>
					(call[1] as string[]).includes("JSON"),
				),
			}).toEqual({ skipped: false, ranVale: true });
		} finally {
			env.cleanup();
		}
	});
});
