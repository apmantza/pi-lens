import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawn = vi.fn((..._args: unknown[]) => ({
	error: undefined,
	status: 0,
	stdout: "",
	stderr: "",
}));
const safeSpawnAsync = vi.fn((...args: Parameters<typeof safeSpawn>) =>
	Promise.resolve(safeSpawn(...args)),
);

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn,
	safeSpawnAsync,
}));

vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		createAvailabilityChecker: (command: string) => ({
			isAvailable: () => true,
			isAvailableAsync: async () => true,
			getCommand: () => command,
		}),
		resolveToolCommandWithInstallFallback: vi.fn(
			async (_cwd: string, toolId: string) => toolId,
		),
	}),
);

function createCtx(
	kind: "yaml" | "sql",
	filePath: string,
	cwd = process.cwd(),
) {
	return makeRunnerCtx(filePath, cwd, { kind });
}

describe("yaml/sql runners", () => {
	beforeEach(async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(safeSpawnMod.safeSpawn).mockReset();
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockReset();
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockImplementation(
			(...args: Parameters<typeof safeSpawn>) =>
				Promise.resolve(safeSpawn(...args)),
		);
	});

	it("yamllint runner maps error severity to blocking", async () => {
		const env = setupTestEnvironment("pi-lens-yamllint-runner-");
		try {
			const runner = (
				await import("../../../../clients/dispatch/runners/yamllint.js")
			).default;
			const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
			fs.writeFileSync(
				path.join(env.tmpDir, ".yamllint"),
				"extends: default\n",
			);

			vi.mocked(safeSpawnMod.safeSpawn).mockReturnValue({
				error: undefined,
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
			const runner = (
				await import("../../../../clients/dispatch/runners/sqlfluff.js")
			).default;
			const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
			fs.writeFileSync(
				path.join(env.tmpDir, ".sqlfluff"),
				"[sqlfluff]\ndialect = postgres\n",
			);

			vi.mocked(safeSpawnMod.safeSpawn).mockReturnValue({
				error: undefined,
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
				createCtx(
					"sql",
					path.join(env.tmpDir, "query.sql"),
					env.tmpDir,
				) as never,
			);
			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.rule).toBe("LT01");
		} finally {
			env.cleanup();
		}
	});

	// #1731: the runner spawned sqlfluff with no `cwd`, so it resolved
	// `.sqlfluff`/`pyproject.toml` and any relative path against
	// `process.cwd()` (the pi-lens extension host's cwd) instead of `ctx.cwd`
	// (the project being linted) — taplo and biome-check both pass `cwd`.
	it("sqlfluff runner spawns with the dispatch context's cwd, not the host's (#1731)", async () => {
		const env = setupTestEnvironment("pi-lens-sqlfluff-cwd-");
		try {
			const runner = (
				await import("../../../../clients/dispatch/runners/sqlfluff.js")
			).default;
			const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
			fs.writeFileSync(
				path.join(env.tmpDir, ".sqlfluff"),
				"[sqlfluff]\ndialect = postgres\n",
			);
			vi.mocked(safeSpawnMod.safeSpawn).mockReturnValue({
				error: undefined,
				status: 0,
				stdout: "[]",
				stderr: "",
			});

			await runner.run(
				createCtx(
					"sql",
					path.join(env.tmpDir, "query.sql"),
					env.tmpDir,
				) as never,
			);

			expect(safeSpawn).toHaveBeenCalled();
			const [, , options] = safeSpawn.mock.calls[0] as [
				string,
				string[],
				{ cwd?: string } | undefined,
			];
			expect(options?.cwd).toBe(env.tmpDir);
		} finally {
			env.cleanup();
		}
	});

	// #2691: the lint spawn passed no `cwd`, so yamllint discovered
	// `.yamllint` by walking upward from the extension host's `process.cwd()`
	// (yamllint/cli.py's `find_project_config_filepath` defaults to `path='.'`
	// and only ever climbs from there — it never looks at the target file's
	// own directory) instead of `ctx.cwd`, even though `hasYamllintConfig`
	// and the availability probe both already used `ctx.cwd`. Same shape as
	// #1731 (sqlfluff) above.
	it("yamllint runner spawns the lint with the dispatch context's cwd, not the host's (#2691)", async () => {
		const env = setupTestEnvironment("pi-lens-yamllint-cwd-");
		try {
			const runner = (
				await import("../../../../clients/dispatch/runners/yamllint.js")
			).default;
			const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
			fs.writeFileSync(
				path.join(env.tmpDir, ".yamllint"),
				"extends: default\n",
			);
			vi.mocked(safeSpawnMod.safeSpawn).mockReturnValue({
				error: undefined,
				status: 0,
				stdout: "",
				stderr: "",
			});

			await runner.run(
				createCtx("yaml", path.join(env.tmpDir, "a.yaml"), env.tmpDir) as never,
			);

			expect(safeSpawn).toHaveBeenCalled();
			const [, , options] = safeSpawn.mock.calls[0] as [
				string,
				string[],
				{ cwd?: string } | undefined,
			];
			expect(options?.cwd).toBe(env.tmpDir);
		} finally {
			env.cleanup();
		}
	});
});
