import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createAvailabilityChecker,
	resolveCommandArgsWithInstallFallback,
	resolveCommandWithInstallFallback,
	resolveNodeToolCommand,
	resolveToolCommand,
	resolveToolCommandWithInstallFallback,
} from "../../../../clients/dispatch/runners/utils/runner-helpers.ts";
import { setupTestEnvironment } from "../../test-utils.js";

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
	safeSpawnAsync: vi.fn(async () => ({ stdout: "", stderr: "", status: 1 })),
}));

vi.mock("../../../../clients/installer/index.js", () => ({
	ensureTool: vi.fn(async () => null),
}));

describe("runner-helpers availability checker", () => {
	beforeEach(async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(safeSpawnMod.safeSpawn).mockReset();
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockReset();
		vi.mocked(installerMod.ensureTool).mockReset();
	});

	it("resolves local node_modules/.bin commands before global fallback", () => {
		const env = setupTestEnvironment("pi-lens-node-bin-");
		try {
			const localUnix = path.join(env.tmpDir, "node_modules", ".bin", "eslint");
			const localWin = path.join(
				env.tmpDir,
				"node_modules",
				".bin",
				"eslint.cmd",
			);
			fs.mkdirSync(path.dirname(localUnix), { recursive: true });
			fs.writeFileSync(localUnix, "#!/bin/sh\nexit 0\n");
			fs.writeFileSync(localWin, "@echo off\n");

			const resolved = resolveNodeToolCommand(env.tmpDir, "eslint");
			expect(resolved).toContain(path.join("node_modules", ".bin"));
		} finally {
			env.cleanup();
		}
	});

	it("falls back to global command when no local node_modules binary exists", () => {
		const env = setupTestEnvironment("pi-lens-node-bin-global-");
		try {
			expect(resolveNodeToolCommand(env.tmpDir, "eslint")).toBe("eslint");
			expect(resolveToolCommand(env.tmpDir, "eslint")).toBe("eslint");
		} finally {
			env.cleanup();
		}
	});

	it("resolves installed command after version check fallback", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync)
			.mockResolvedValueOnce({ stdout: "", stderr: "not found", status: 1 })
			.mockResolvedValueOnce({ stdout: "1.0.0", stderr: "", status: 0 });
		vi.mocked(installerMod.ensureTool).mockResolvedValue("stylelint");

		const resolved = await resolveCommandWithInstallFallback(
			"stylelint",
			"stylelint",
			process.cwd(),
		);

		expect(installerMod.ensureTool).toHaveBeenCalledWith("stylelint");
		expect(resolved).toBe("stylelint");
	});

	it("preserves existing command args when project command verifies", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValueOnce({
			stdout: "rubocop 1.0.0",
			stderr: "",
			status: 0,
		});

		const resolved = await resolveCommandArgsWithInstallFallback(
			{ cmd: "bundle", args: ["exec", "rubocop"] },
			"rubocop",
			process.cwd(),
			["--version"],
			10000,
		);

		expect(resolved).toEqual({ cmd: "bundle", args: ["exec", "rubocop"] });
	});

	it("does not auto-install config-first tools", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValueOnce({
			stdout: "",
			stderr: "not found",
			status: 1,
		});

		const resolved = await resolveCommandWithInstallFallback(
			"eslint",
			"eslint",
			process.cwd(),
		);
		const resolvedByToolId = await resolveToolCommandWithInstallFallback(
			process.cwd(),
			"eslint",
		);

		expect(installerMod.ensureTool).not.toHaveBeenCalled();
		expect(resolved).toBeNull();
		expect(resolvedByToolId).toBeNull();
	});

	it("caches availability per cwd (does not leak false across projects)", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const dirA = setupTestEnvironment("pi-lens-a-");
		const dirB = setupTestEnvironment("pi-lens-b-");
		try {
			const ruffBUnix = path.join(dirB.tmpDir, ".venv", "bin", "ruff");
			const ruffBWin = path.join(dirB.tmpDir, ".venv", "Scripts", "ruff.exe");
			fs.mkdirSync(path.dirname(ruffBUnix), { recursive: true });
			fs.mkdirSync(path.dirname(ruffBWin), { recursive: true });
			fs.writeFileSync(ruffBUnix, "#!/bin/sh\nexit 0\n");
			fs.writeFileSync(ruffBWin, "@echo off\n");

			const checker = createAvailabilityChecker("ruff", ".exe");

			vi.mocked(safeSpawnMod.safeSpawn).mockImplementation((cmd) => {
				const text = String(cmd);
				if (text.includes(dirB.tmpDir)) {
					return { stdout: "ruff 1.0.0", stderr: "", status: 0 };
				}
				return { stdout: "", stderr: "not found", status: 1 };
			});

			expect(checker.isAvailable(dirA.tmpDir)).toBe(false);
			expect(checker.isAvailable(dirB.tmpDir)).toBe(true);
			expect(checker.getCommand(dirA.tmpDir)).toBeNull();
			expect(checker.getCommand(dirB.tmpDir)).toContain(dirB.tmpDir);
		} finally {
			dirA.cleanup();
			dirB.cleanup();
		}
	});
});
