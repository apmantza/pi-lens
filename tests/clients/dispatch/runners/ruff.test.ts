import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawn = vi.fn();
const safeSpawnAsync = vi.fn();
const ensureTool = vi.fn(async () => "ruff");

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn,
	safeSpawnAsync,
}));

vi.mock("../../../../clients/installer/index.js", () => ({
	ensureTool,
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
				await import("../../../../clients/dispatch/runners/ruff.ts")
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
});
