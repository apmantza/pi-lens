import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn();

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(),
	safeSpawnAsync,
}));

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	createAvailabilityChecker: () => ({
		isAvailable: () => true,
		isAvailableAsync: async () => true,
		getCommand: () => "stylelint",
	}),
	resolveToolCommandWithInstallFallback: vi.fn(async () => "stylelint"),
}));

vi.mock("../../../../clients/tool-policy.js", async (importOriginal) => {
	const actual = await importOriginal<
		typeof import("../../../../clients/tool-policy.js")
	>();
	return {
		...actual,
		getLinterPolicyForCwd: () => null,
		hasStylelintConfig: () => true,
	};
});

function createCtx(filePath: string, cwd: string) {
	return {
		filePath,
		cwd,
		kind: "css" as const,
		fileRole: "source" as const,
		pi: { getFlag: () => undefined },
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

describe("stylelint runner — fixable metadata", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});

	it("marks known-fixable rules as fixable with a fixSuggestion", async () => {
		const env = setupTestEnvironment("pi-lens-stylelint-fixable-");
		try {
			const filePath = path.join(env.tmpDir, "sample.css");
			fs.writeFileSync(filePath, "a { color: red; }\n");

			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: JSON.stringify([
					{
						source: filePath,
						warnings: [
							{
								line: 1,
								column: 1,
								severity: "warning",
								rule: "no-eol-whitespace",
								text: "Unexpected trailing whitespace (no-eol-whitespace)",
							},
							{
								line: 1,
								column: 5,
								severity: "warning",
								rule: "selector-pseudo-element-no-unknown",
								text: "Unexpected unknown pseudo-element (selector-pseudo-element-no-unknown)",
							},
						],
					},
				]),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/stylelint.ts")
			).default;
			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.diagnostics).toHaveLength(2);
			const fixableDiag = result.diagnostics.find(
				(d) => d.rule === "no-eol-whitespace",
			);
			const notFixableDiag = result.diagnostics.find(
				(d) => d.rule === "selector-pseudo-element-no-unknown",
			);
			expect(fixableDiag?.fixable).toBe(true);
			expect(fixableDiag?.fixSuggestion).toMatch(/stylelint --fix/);
			expect(notFixableDiag?.fixable).toBeFalsy();
			expect(notFixableDiag?.fixSuggestion).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});
