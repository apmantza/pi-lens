import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({
		error: null,
		status: 0,
		stdout: "",
		stderr: "",
	})),
}));

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	createAvailabilityChecker: () => ({
		isAvailable: () => true,
		getCommand: () => "shellcheck",
	}),
}));

function createShellCtx(filePath: string, cwd: string) {
	return {
		filePath,
		cwd,
		kind: "shell",
		pi: { getFlag: () => false },
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

describe("shellcheck runner", () => {
	beforeEach(async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(safeSpawnMod.safeSpawn).mockReset();
	});

	it("adds --severity warning when no .shellcheckrc exists", async () => {
		const shellcheckRunner = (await import(
			"../../../../clients/dispatch/runners/shellcheck.js"
		)).default;
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");

		vi.mocked(safeSpawnMod.safeSpawn).mockReturnValue({
			error: null,
			status: 0,
			stdout: "",
			stderr: "",
		});

		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-shell-");
		try {
			const filePath = path.join(tmpDir, "script.sh");
			fs.writeFileSync(filePath, "#!/bin/bash\necho ok\n");

			await shellcheckRunner.run(createShellCtx(filePath, tmpDir) as never);

			const args = vi.mocked(safeSpawnMod.safeSpawn).mock.calls[0]?.[1] ?? [];
			expect(args).toContain("--severity");
			expect(args).toContain("warning");
		} finally {
			cleanup();
		}
	});

	it("finds parent .shellcheckrc and does not force --severity", async () => {
		const shellcheckRunner = (await import(
			"../../../../clients/dispatch/runners/shellcheck.js"
		)).default;
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");

		vi.mocked(safeSpawnMod.safeSpawn).mockReturnValue({
			error: null,
			status: 0,
			stdout: "",
			stderr: "",
		});

		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-shell-");
		try {
			fs.writeFileSync(path.join(tmpDir, ".shellcheckrc"), "disable=SC1090\n");
			const subdir = path.join(tmpDir, "scripts", "ci");
			fs.mkdirSync(subdir, { recursive: true });
			const filePath = path.join(subdir, "script.sh");
			fs.writeFileSync(filePath, "#!/bin/bash\necho ok\n");

			await shellcheckRunner.run(createShellCtx(filePath, subdir) as never);

			const args = vi.mocked(safeSpawnMod.safeSpawn).mock.calls[0]?.[1] ?? [];
			expect(args).not.toContain("--severity");
		} finally {
			cleanup();
		}
	});

	it("returns failed/blocking when shellcheck reports error severity", async () => {
		const shellcheckRunner = (await import(
			"../../../../clients/dispatch/runners/shellcheck.js"
		)).default;
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");

		vi.mocked(safeSpawnMod.safeSpawn).mockReturnValue({
			error: null,
			status: 1,
			stdout: JSON.stringify([
				{
					line: 3,
					column: 1,
					level: "error",
					code: 1000,
					message: "syntax error",
				},
			]),
			stderr: "",
		});

		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-shell-");
		try {
			const filePath = path.join(tmpDir, "script.sh");
			fs.writeFileSync(filePath, "#!/bin/bash\nif then\n");

			const result = await shellcheckRunner.run(
				createShellCtx(filePath, tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
		} finally {
			cleanup();
		}
	});
});
