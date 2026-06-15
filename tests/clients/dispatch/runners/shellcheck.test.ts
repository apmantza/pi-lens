import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawn = vi.fn((..._args: unknown[]) => ({
	error: null,
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

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	createAvailabilityChecker: () => ({
		isAvailable: () => true,
		isAvailableAsync: async () => true,
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
	beforeEach(() => {
		vi.resetModules();
		safeSpawn.mockReset();
		safeSpawnAsync.mockReset();
		safeSpawnAsync.mockImplementation((...args: Parameters<typeof safeSpawn>) =>
			Promise.resolve(safeSpawn(...args)),
		);
	});

	it("adds --severity info when no .shellcheckrc exists (surfaces SC2086, #213)", async () => {
		const env = setupTestEnvironment("pi-lens-shellcheck-");
		try {
			const filePath = path.join(env.tmpDir, "script.sh");
			fs.writeFileSync(filePath, "echo $x\n");
			safeSpawn.mockReturnValue({
				error: null,
				status: 0,
				stdout: "",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/shellcheck.js")
			).default;
			await runner.run(createShellCtx(filePath, env.tmpDir) as never);

			const args = safeSpawn.mock.calls[0]?.[1] ?? [];
			expect(args).toContain("--severity");
			// info (not warning) so SC2086-class info findings surface; pure `style`
			// stays opt-in via .shellcheckrc.
			expect(args).toContain("info");
			expect(args).not.toContain("warning");
		} finally {
			env.cleanup();
		}
	});

	it("finds parent .shellcheckrc and does not force --severity", async () => {
		const env = setupTestEnvironment("pi-lens-shellcheck-");
		try {
			fs.writeFileSync(
				path.join(env.tmpDir, ".shellcheckrc"),
				"disable=SC2034\n",
			);
			const filePath = path.join(env.tmpDir, "scripts", "script.sh");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "echo $x\n");
			safeSpawn.mockReturnValue({
				error: null,
				status: 0,
				stdout: "",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/shellcheck.js")
			).default;
			await runner.run(createShellCtx(filePath, env.tmpDir) as never);

			const args = safeSpawn.mock.calls[0]?.[1] ?? [];
			expect(args).not.toContain("--severity");
		} finally {
			env.cleanup();
		}
	});

	it("appliesTo shell but not fish (so dispatch skips .fish files)", async () => {
		const runner = (
			await import("../../../../clients/dispatch/runners/shellcheck.js")
		).default;
		expect(runner.appliesTo).toContain("shell");
		expect(runner.appliesTo).not.toContain("fish");
	});

	it("returns failed/blocking when shellcheck reports error severity", async () => {
		const env = setupTestEnvironment("pi-lens-shellcheck-");
		try {
			const filePath = path.join(env.tmpDir, "script.sh");
			fs.writeFileSync(filePath, "echo $x\n");
			safeSpawn.mockReturnValue({
				error: null,
				status: 1,
				stdout: JSON.stringify([
					{
						file: filePath,
						line: 1,
						column: 1,
						level: "error",
						code: 2086,
						message: "Double quote to prevent globbing",
					},
				]),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/shellcheck.js")
			).default;
			const result = await runner.run(
				createShellCtx(filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0]?.semantic).toBe("blocking");
		} finally {
			env.cleanup();
		}
	});
});
