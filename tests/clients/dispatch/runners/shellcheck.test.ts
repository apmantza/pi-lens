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

const lspPrimaryCoversFile = vi.fn((..._args: unknown[]) => false);
vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")>()),
	createAvailabilityChecker: () => ({
		isAvailable: () => true,
		isAvailableAsync: async () => true,
		getCommand: () => "shellcheck",
	}),
	lspPrimaryCoversFile: (...args: unknown[]) => lspPrimaryCoversFile(...args),
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
		lspPrimaryCoversFile.mockReset();
		lspPrimaryCoversFile.mockReturnValue(false);
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

	// #2691: the lint spawn passed no `cwd`, so it ran under the extension
	// host's `process.cwd()` instead of `ctx.cwd` -- same shape as #1731
	// (sqlfluff) and #2691's own yamllint.
	it("spawns shellcheck with the dispatch context's cwd, not the host's (#2691)", async () => {
		const env = setupTestEnvironment("pi-lens-shellcheck-cwd-");
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

	it("self-skips (no CLI spawn) when the bash LSP covers the file + tools present (#233)", async () => {
		const env = setupTestEnvironment("pi-lens-shellcheck-");
		try {
			const filePath = path.join(env.tmpDir, "script.sh");
			fs.writeFileSync(filePath, "echo $x\n");
			lspPrimaryCoversFile.mockReturnValue(true); // bash LSP is the primary

			const runner = (
				await import("../../../../clients/dispatch/runners/shellcheck.js")
			).default;
			// hasTool true for both bash-language-server + shellcheck → LSP covers
			const result = await runner.run(
				createShellCtx(filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("skipped");
			expect(safeSpawn).not.toHaveBeenCalled(); // no redundant CLI scan
		} finally {
			env.cleanup();
		}
	});

	it("still runs when the bash LSP is unavailable even if it would be primary (#233)", async () => {
		const env = setupTestEnvironment("pi-lens-shellcheck-");
		try {
			const filePath = path.join(env.tmpDir, "script.sh");
			fs.writeFileSync(filePath, "echo $x\n");
			lspPrimaryCoversFile.mockReturnValue(true);
			safeSpawn.mockReturnValue({
				error: null,
				status: 0,
				stdout: "",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/shellcheck.js")
			).default;
			// bash-language-server NOT installed → LSP can't actually cover → run CLI
			const ctx = {
				...createShellCtx(filePath, env.tmpDir),
				hasTool: async (t: string) => t !== "bash-language-server",
			};
			const result = await runner.run(ctx as never);

			expect(result.status).not.toBe("skipped");
			expect(safeSpawn).toHaveBeenCalled();
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
