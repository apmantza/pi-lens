import { beforeEach, describe, expect, it, vi } from "vitest";

// #1087 P1, tool-level: a valid `severity: error` rule that MATCHES the
// validation snippet must be reported VALID. ast-grep exits 1 with JSON matches
// on stdout in that case (linter-style contract), which the old
// interpretScanResult misclassified as a cli-failure — so validateRule declared
// the perfectly valid rule invalid. This drives the REAL AstGrepClient ->
// SgRunner.tempScanDetailedAsync -> interpretScanResult chain with only the
// subprocess boundary (safeSpawnAsync) mocked.

const safeSpawnAsync = vi.fn();
const safeSpawn = vi.fn();
const getSgCommand = vi.fn();

vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync, safeSpawn }));
vi.mock("../../clients/dispatch/runners/utils/runner-helpers.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/dispatch/runners/utils/runner-helpers.js")>()),
	getSgCommand,
}));

describe("validateRule honors ast-grep's status-1-with-matches contract (#1087)", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		getSgCommand.mockReturnValue({ cmd: "ast-grep", args: [] });
	});

	it("reports a matching severity:error rule as VALID (not a cli-failure)", async () => {
		const matchJson = JSON.stringify([
			{
				file: "snippet.ts",
				range: {
					start: { line: 0, column: 0 },
					end: { line: 0, column: 7 },
				},
				text: "eval(x)",
				ruleId: "no-eval-test",
				severity: "error",
			},
		]);
		// The exact shape observed from the bundled ast-grep 0.45.0 binary.
		safeSpawnAsync.mockResolvedValue({
			status: 1,
			error: undefined,
			stdout: matchJson,
			stderr:
				"Error: 1 error(s) found in code.\nHelp: Scan succeeded and found error level diagnostics in the codebase.",
		});

		const { AstGrepClient } = await import("../../clients/ast-grep-client.js");
		const client = new AstGrepClient();
		const result = await client.validateRule(
			"id: no-eval-test\nlanguage: typescript\nseverity: error\nrule:\n  pattern: eval($ARG)\nmessage: no eval\n",
		);

		expect(result.valid).toBe(true);
		expect(result.error).toBeUndefined();
	});

	it("still reports a genuinely broken rule as invalid", async () => {
		safeSpawnAsync.mockResolvedValue({
			status: 2,
			error: undefined,
			stdout: "",
			stderr: "Error: invalid rule config",
		});

		const { AstGrepClient } = await import("../../clients/ast-grep-client.js");
		const client = new AstGrepClient();
		const result = await client.validateRule(
			"id: broken\nlanguage: typescript\nrule:\n  kind: definitely_not_a_kind\n",
		);

		expect(result.valid).toBe(false);
		expect(result.error).toContain("invalid rule config");
	});
});
