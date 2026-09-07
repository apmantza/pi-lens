import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawn = vi.fn();
const safeSpawnAsync = vi.fn();
const ensureTool = vi.fn(async (_toolId: string) => "ruff");
const resolveAvailableOrInstall = vi.fn(async () => ensureTool("ruff"));

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn,
	safeSpawnAsync,
}));

vi.mock("../../../../clients/installer/index.js", () => ({
	ensureTool,
}));

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	createAvailabilityChecker: vi.fn(() => ({
		isAvailableAsync: vi.fn(async () => false),
		getCommand: vi.fn(() => null),
	})),
	resolveAvailableOrInstall,
}));

function createCtx(filePath: string, cwd: string) {
	return makeRunnerCtx(filePath, cwd, { kind: "python" });
}

describe("ruff runner", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawn.mockReset();
		safeSpawnAsync.mockReset();
		ensureTool.mockReset();
		ensureTool.mockResolvedValue("ruff");
		// Simulate ruff not being available on PATH/venv so ensureTool path is used.
		safeSpawn.mockReturnValue({ error: new Error("not found"), status: 1 });
	});

	it("runs diagnostics-only check without mutating file", async () => {
		const env = setupTestEnvironment("pi-lens-ruff-runner-");
		try {
			const filePath = path.join(env.tmpDir, "sample.py");
			fs.writeFileSync(filePath, "import os\n");

			safeSpawnAsync
				.mockResolvedValueOnce({
					error: new Error("not found"),
					status: 1,
					stdout: "",
					stderr: "",
				})
				.mockResolvedValueOnce({
					error: null,
					status: 1,
					stdout: "[]",
					stderr: "",
				});

			const runner = (
				await import("../../../../clients/dispatch/runners/ruff.js")
			).default;

			await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(ensureTool).toHaveBeenCalledWith("ruff");
			const ruffCalls = safeSpawnAsync.mock.calls
				.filter((call) => call[0] === "ruff")
				.map((call) => call[1] as string[]);
			expect(
				ruffCalls.some(
					(args) =>
						args.includes("check") &&
						args.includes("--output-format") &&
						args.includes("json") &&
						args.includes(filePath),
				),
			).toBe(true);
			expect(ruffCalls.some((args) => args.includes("--fix"))).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	// #2691: the check spawn passed no `cwd`, so a nested `pyproject.toml`
	// config was resolved against the extension host's `process.cwd()`
	// instead of `ctx.cwd` -- same shape as #1731 (sqlfluff), even though
	// ruff itself walks upward from the linted FILE's own directory for
	// `pyproject.toml`/`ruff.toml` discovery (ruff_workspace's
	// `find_settings_toml` iterates `path.ancestors()` of the target path,
	// not the process cwd), so this is a consistency fix that keeps the lint
	// spawn's cwd aligned with the availability probe and `ruffConfigArgs`,
	// not a config-resolution behavior change.
	it("ruff runner spawns the check with the dispatch context's cwd, not the host's (#2691)", async () => {
		const env = setupTestEnvironment("pi-lens-ruff-cwd-");
		try {
			const filePath = path.join(env.tmpDir, "sample.py");
			fs.writeFileSync(filePath, "import os\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: "[]",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/ruff.js")
			).default;

			await runner.run(createCtx(filePath, env.tmpDir) as never);

			const checkCall = safeSpawnAsync.mock.calls.find(
				(call) => (call[1] as string[]).includes("check"),
			) as [string, string[], { cwd?: string } | undefined];
			expect(checkCall).toBeDefined();
			expect(checkCall[2]?.cwd).toBe(env.tmpDir);
		} finally {
			env.cleanup();
		}
	});
});
