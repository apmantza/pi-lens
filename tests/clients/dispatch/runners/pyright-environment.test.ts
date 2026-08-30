import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.hoisted(() => vi.fn());
const getClientForFile = vi.hoisted(() => vi.fn(async () => undefined));
const isAvailableAsync = vi.hoisted(() => vi.fn(async () => true));
const getCommand = vi.hoisted(() => vi.fn(() => "pyright"));
const resolveAvailableOrInstall = vi.hoisted(() => vi.fn());

vi.mock("../../../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));

vi.mock("../../../../clients/lsp/index.js", () => ({
	getLSPService: () => ({ getClientForFile }),
}));

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	createAvailabilityChecker: () => ({ isAvailableAsync, getCommand }),
	resolveAvailableOrInstall,
}));

const originalVenv = process.env.VIRTUAL_ENV;
const originalConda = process.env.CONDA_PREFIX;

beforeEach(() => {
	vi.resetModules();
	safeSpawnAsync.mockReset();
	getClientForFile.mockClear();
	isAvailableAsync.mockClear();
	getCommand.mockClear();
	resolveAvailableOrInstall.mockReset();
	delete process.env.VIRTUAL_ENV;
	delete process.env.CONDA_PREFIX;
});

afterEach(() => {
	if (originalVenv === undefined) delete process.env.VIRTUAL_ENV;
	else process.env.VIRTUAL_ENV = originalVenv;
	if (originalConda === undefined) delete process.env.CONDA_PREFIX;
	else process.env.CONDA_PREFIX = originalConda;
});

describe("pyright project environment", () => {
	it("runs managed Pyright against an unactivated project .venv", async () => {
		const env = setupTestEnvironment("pi-lens-pyright-venv-");
		try {
			const filePath = path.join(env.tmpDir, "sample.py");
			fs.writeFileSync(filePath, "import project_dependency\n");

			const environmentRoot = path.join(env.tmpDir, ".venv");
			const binDir = path.join(
				environmentRoot,
				process.platform === "win32" ? "Scripts" : "bin",
			);
			const pythonPath = path.join(
				binDir,
				process.platform === "win32" ? "python.exe" : "python",
			);
			fs.mkdirSync(binDir, { recursive: true });
			fs.writeFileSync(pythonPath, "#!/usr/bin/env python\n");

			let pyrightOptions: { cwd?: string; env?: NodeJS.ProcessEnv } | undefined;
			safeSpawnAsync.mockImplementation(
				async (
					_command: string,
					_args: string[],
					options?: { cwd?: string; env?: NodeJS.ProcessEnv },
				) => {
					pyrightOptions = options;
					return {
						error: null,
						status: 0,
						stdout: JSON.stringify({ generalDiagnostics: [] }),
						stderr: "",
					};
				},
			);

			const runner = (
				await import("../../../../clients/dispatch/runners/pyright.js")
			).default;
			const result = await runner.run(
				makeRunnerCtx(filePath, env.tmpDir, { kind: "python" }),
			);

			expect(result.status).toBe("succeeded");
			expect(pyrightOptions?.cwd).toBe(env.tmpDir);
			expect(pyrightOptions?.env?.VIRTUAL_ENV).toBe(environmentRoot);
			expect(pyrightOptions?.env?.PATH?.split(path.delimiter)[0]).toBe(binDir);
			expect(process.env.VIRTUAL_ENV).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});
