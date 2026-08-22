/**
 * Regression for the tier-1 parser-smoke failure: htmlhint reported 0
 * findings on a file with a planted tag-pair violation.
 *
 * Root cause (root-caused live against htmlhint 1.x): the runner passed its
 * ruleset to `--rules` as a JSON OBJECT, but the flag takes a comma-separated
 * ruleid list ("tag-pair,id-class-value=underline"). The whole JSON blob was
 * consumed as one bogus rule id, ZERO rules stayed enabled, and every file —
 * clean or broken — exited 0 with no output. The parser was never wrong; the
 * invocation asked the tool nothing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn();

vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	safeSpawnAsync,
}));

vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<Record<string, unknown>>()),
		resolveToolCommandWithInstallFallback: async (
			_cwd: string,
			toolId: string,
		) => toolId,
	}),
);

function createCtx(filePath: string, cwd: string) {
	return makeRunnerCtx(filePath, cwd);
}

// Real htmlhint 1.x unix-format bytes (captured live from the fixture run).
const REAL_UNIX_OUTPUT = [
	"/tmp/ws/bad.html:6:5: Tag must be paired, missing: [ </div> ], start tag match failed [ <div> ] on line 6. [error/tag-pair]",
	"",
	"\u001b[31m1 problems\u001b[0m",
	"",
].join("\n");

describe("htmlhint runner", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});

	it("passes --rules as a ruleid list, not a JSON object", async () => {
		const env = setupTestEnvironment("pi-lens-htmlhint-rules-argv-");
		try {
			const filePath = path.join(env.tmpDir, "bad.html");
			fs.writeFileSync(filePath, "<div>\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: "",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/htmlhint.js")
			).default;
			await runner.run(createCtx(filePath, env.tmpDir) as never);

			// The runner probes availability before linting; assert on the LINT
			// spawn, not the first call.
			const lintCall = safeSpawnAsync.mock.calls.find((call) =>
				((call[1] ?? []) as string[]).includes("--rules"),
			);
			expect(lintCall).toBeDefined();
			const argv = lintCall![1] as string[];
			const rulesValue = argv[argv.indexOf("--rules") + 1];
			expect(rulesValue).toBeDefined();
			// The old bug in one assertion: this must never be JSON again.
			expect(rulesValue.startsWith("{")).toBe(false);
			for (const rule of [
				"tag-pair",
				"attr-no-duplication",
				"tagname-lowercase",
				"spec-char-escape",
				"id-unique",
			]) {
				expect(rulesValue.split(",")).toContain(rule);
			}
		} finally {
			env.cleanup();
		}
	});

	it("parses real unix-format findings into blocking diagnostics", async () => {
		const env = setupTestEnvironment("pi-lens-htmlhint-findings-");
		try {
			const filePath = path.join(env.tmpDir, "bad.html");
			fs.writeFileSync(filePath, "<div>\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: REAL_UNIX_OUTPUT,
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/htmlhint.js")
			).default;
			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("failed");
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]).toMatchObject({
				tool: "htmlhint",
				rule: "tag-pair",
				line: 6,
				column: 5,
				severity: "error",
				semantic: "blocking",
			});
		} finally {
			env.cleanup();
		}
	});
});
