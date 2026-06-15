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
		getCommand: () => "markdownlint-cli2",
	}),
	resolveToolCommandWithInstallFallback: vi.fn(async () => "markdownlint-cli2"),
}));

vi.mock("../../../../clients/tool-policy.js", async (importOriginal) => {
	const actual = await importOriginal<
		typeof import("../../../../clients/tool-policy.js")
	>();
	return {
		...actual,
		getLinterPolicyForCwd: () => null,
		hasMarkdownlintConfig: () => true,
	};
});

function createCtx(filePath: string, cwd: string) {
	return {
		filePath,
		cwd,
		kind: "markdown" as const,
		fileRole: "source" as const,
		pi: { getFlag: () => undefined },
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

describe("markdownlint runner — fixable metadata", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});

	it("marks known-fixable MD rules as fixable with a fixSuggestion", async () => {
		const env = setupTestEnvironment("pi-lens-markdownlint-fixable-");
		try {
			const filePath = path.join(env.tmpDir, "README.md");
			fs.writeFileSync(filePath, "# Title\n");

			// MD009 (trailing spaces) is fixable; MD013 (line-length) is not.
			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: [
					`${filePath}:1 MD009/no-trailing-spaces Trailing spaces`,
					`${filePath}:2 MD013/line-length Line length`,
				].join("\n"),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/markdownlint.ts")
			).default;
			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.diagnostics.length).toBeGreaterThanOrEqual(2);
			const md009 = result.diagnostics.find((d) => d.rule === "MD009");
			const md013 = result.diagnostics.find((d) => d.rule === "MD013");
			expect(md009?.fixable).toBe(true);
			expect(md009?.fixSuggestion).toMatch(/markdownlint-cli2 --fix/);
			expect(md013?.fixable).toBeFalsy();
			expect(md013?.fixSuggestion).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	// Regression for #212: markdownlint-cli2 emits a severity token (`error`/
	// `warning`) between the col and the rule code, and some rules carry multiple
	// slash-separated names — both of which the old parser missed, silently
	// returning 0 diagnostics.
	it("parses the markdownlint-cli2 format (severity token + multi-segment rule)", async () => {
		const env = setupTestEnvironment("pi-lens-markdownlint-cli2fmt-");
		try {
			const filePath = path.join(env.tmpDir, "README.md");
			fs.writeFileSync(filePath, "#Title\n");

			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: [
					`${filePath}:1:1 error MD018/no-missing-space-atx No space after hash`,
					`${filePath}:1 error MD041/first-line-heading/first-line-h1 First line should be a top-level heading`,
					`${filePath}:2:14 warning MD009/no-trailing-spaces Trailing spaces`,
				].join("\n"),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/markdownlint.ts")
			).default;
			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.diagnostics.length).toBe(3);
			expect(result.diagnostics.map((d) => d.rule).sort()).toEqual([
				"MD009",
				"MD018",
				"MD041",
			]);
			const md041 = result.diagnostics.find((d) => d.rule === "MD041");
			expect(md041?.line).toBe(1);
		} finally {
			env.cleanup();
		}
	});
});
