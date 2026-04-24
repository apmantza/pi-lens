import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawn = vi.fn();
const safeSpawnAsync = vi.fn();
const ensureTool = vi.fn(async (_toolId?: string) => "oxlint");

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn,
	safeSpawnAsync,
}));

vi.mock("../../../../clients/installer/index.js", () => ({
	ensureTool,
}));

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	createAvailabilityChecker: () => ({
		isAvailable: () => false,
		getCommand: () => null,
	}),
	resolveToolCommandWithInstallFallback: vi.fn(async (_cwd: string) => {
		const installed = await ensureTool("oxlint");
		return installed ?? null;
	}),
}));

function createCtx(filePath: string, cwd: string) {
	return {
		filePath,
		cwd,
		kind: "jsts",
		pi: {
			getFlag: () => undefined,
		},
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

describe("oxlint runner", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawn.mockReset();
		safeSpawnAsync.mockReset();
		ensureTool.mockReset();
		ensureTool.mockResolvedValue("oxlint");
		// Simulate oxlint not being available on PATH/venv so ensureTool path is used.
		safeSpawn.mockReturnValue({ error: new Error("not found"), status: 1 });
	});

	it("auto-installs and runs oxlint as the no-config JS/TS fallback", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-runner-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "console.log('hi')\n");

			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: `${filePath}:1:1: Unexpected console statement (no-console)\n`,
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.ts")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(ensureTool).toHaveBeenCalledWith("oxlint");
			expect(safeSpawnAsync).toHaveBeenCalledWith(
				"oxlint",
				expect.arrayContaining(["--format", "unix", filePath]),
				expect.objectContaining({ timeout: 30000 }),
			);
			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]).toMatchObject({
				tool: "oxlint",
				rule: "no-console",
				line: 1,
			});
		} finally {
			env.cleanup();
		}
	});

	it("skips when ESLint is explicitly configured", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-eslint-config-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const x = 1\n");
			fs.writeFileSync(path.join(env.tmpDir, ".eslintrc.json"), "{}\n");

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.ts")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("skipped");
			expect(ensureTool).not.toHaveBeenCalled();
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});
});
