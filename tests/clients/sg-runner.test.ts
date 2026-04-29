import { beforeEach, describe, expect, it, vi } from "vitest";

const safeSpawnAsync = vi.fn();
const safeSpawn = vi.fn();
const isSgAvailable = vi.fn();
const getSgCommand = vi.fn();

vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync, safeSpawn }));
vi.mock("../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	isSgAvailable,
	getSgCommand,
}));

describe("SgRunner", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		safeSpawnAsync.mockResolvedValue({ status: 1, error: new Error("not found"), stdout: "", stderr: "" });
		safeSpawn.mockReturnValue({ status: 0, stdout: "", stderr: "", error: undefined });
		isSgAvailable.mockReturnValue(false);
		getSgCommand.mockReturnValue({ cmd: "sg", args: [] });
	});

	describe("isAvailable()", () => {
		it("returns false when isSgAvailable returns false", async () => {
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const runner = new SgRunner();
			expect(runner.isAvailable()).toBe(false);
		});

		it("returns true when isSgAvailable returns true", async () => {
			isSgAvailable.mockReturnValue(true);
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const runner = new SgRunner();
			expect(runner.isAvailable()).toBe(true);
		});

		it("caches the result on second call", async () => {
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const runner = new SgRunner();
			runner.isAvailable();
			runner.isAvailable();
			expect(isSgAvailable).toHaveBeenCalledTimes(1);
		});
	});

	describe("ensureAvailable()", () => {
		it("returns true when sg is in PATH", async () => {
			safeSpawnAsync.mockResolvedValueOnce({ status: 0, error: null, stdout: "sg 0.22.0", stderr: "" });
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const runner = new SgRunner();
			const result = await runner.ensureAvailable();
			expect(result).toBe(true);
		});

		it("returns false when sg not found and installer fails", async () => {
			safeSpawnAsync.mockResolvedValueOnce({ status: 1, error: new Error("not found"), stdout: "", stderr: "" });
			vi.doMock("../../clients/installer/index.js", () => ({
				ensureTool: vi.fn().mockResolvedValue(null),
			}));
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const runner = new SgRunner();
			const result = await runner.ensureAvailable();
			expect(result).toBe(false);
		});

		it("caches true result on second call", async () => {
			safeSpawnAsync.mockResolvedValue({ status: 0, error: null, stdout: "sg 0.22.0", stderr: "" });
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const runner = new SgRunner();
			await runner.ensureAvailable();
			await runner.ensureAvailable();
			expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		});
	});

	describe("execSync()", () => {
		it("returns output from stdout on success", async () => {
			safeSpawn.mockReturnValue({ status: 0, stdout: '{"file":"a.ts"}', stderr: "", error: undefined });
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const runner = new SgRunner();
			const result = runner.execSync(["run", "--pattern", "foo"]);
			expect(result.output).toContain("a.ts");
			expect(result.error).toBeUndefined();
		});

		it("falls back to stderr when stdout is empty", async () => {
			safeSpawn.mockReturnValue({ status: 1, stdout: "", stderr: "command failed", error: undefined });
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const runner = new SgRunner();
			const result = runner.execSync(["run"]);
			expect(result.output).toBe("command failed");
		});

		it("returns error message when spawn errors", async () => {
			safeSpawn.mockReturnValue({ status: null, stdout: "", stderr: "", error: new Error("spawn failed") });
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const runner = new SgRunner();
			const result = runner.execSync(["run"]);
			expect(result.error).toBe("spawn failed");
			expect(result.output).toBe("");
		});

		it("passes command args through to safeSpawn", async () => {
			safeSpawn.mockReturnValue({ status: 0, stdout: "", stderr: "", error: undefined });
			const { SgRunner } = await import("../../clients/sg-runner.js");
			const runner = new SgRunner();
			runner.execSync(["scan", "--json"]);
			expect(safeSpawn).toHaveBeenCalledWith(
				"sg",
				expect.arrayContaining(["scan", "--json"]),
				expect.any(Object),
			);
		});
	});
});
