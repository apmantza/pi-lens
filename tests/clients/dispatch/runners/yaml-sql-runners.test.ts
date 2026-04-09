import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ error: null, status: 0, stdout: "", stderr: "" })),
}));

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	createAvailabilityChecker: (command: string) => ({
		isAvailable: () => true,
		getCommand: () => command,
	}),
}));

function createCtx(kind: "yaml" | "sql", filePath: string, cwd = process.cwd()) {
	return {
		filePath,
		cwd,
		kind,
		pi: { getFlag: () => false },
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

describe("yaml/sql runners", () => {
	beforeEach(async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(safeSpawnMod.safeSpawn).mockReset();
	});

	it("yamllint runner maps error severity to blocking", async () => {
		const env = setupTestEnvironment("pi-lens-yamllint-runner-");
		try {
			const runner = (await import(
				"../../../../clients/dispatch/runners/yamllint.js"
			)).default;
			const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
			fs.writeFileSync(path.join(env.tmpDir, ".yamllint"), "extends: default\n");

			vi.mocked(safeSpawnMod.safeSpawn).mockReturnValue({
				error: null,
				status: 1,
				stdout:
					"a.yaml:3:5: [error] syntax error: mapping values are not allowed (syntax)\n",
				stderr: "",
			});

			const result = await runner.run(
				createCtx("yaml", path.join(env.tmpDir, "a.yaml"), env.tmpDir) as never,
			);
			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0]?.tool).toBe("yamllint");
		} finally {
			env.cleanup();
		}
	});

	it("sqlfluff runner returns warning diagnostics", async () => {
		const env = setupTestEnvironment("pi-lens-sqlfluff-runner-");
		try {
			const runner = (await import(
				"../../../../clients/dispatch/runners/sqlfluff.js"
			)).default;
			const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
			fs.writeFileSync(
				path.join(env.tmpDir, ".sqlfluff"),
				"[sqlfluff]\ndialect = postgres\n",
			);

			vi.mocked(safeSpawnMod.safeSpawn).mockReturnValue({
				error: null,
				status: 1,
				stdout: JSON.stringify([
					{
						filepath: "query.sql",
						violations: [
							{
								code: "LT01",
								description: "Expected single whitespace between keywords",
								line_no: 1,
								line_pos: 7,
							},
						],
					},
				]),
				stderr: "",
			});

			const result = await runner.run(
				createCtx("sql", path.join(env.tmpDir, "query.sql"), env.tmpDir) as never,
			);
			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.rule).toBe("LT01");
		} finally {
			env.cleanup();
		}
	});
});
