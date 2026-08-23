import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	safeSpawnAsync,
}));
vi.mock("../../clients/tool-policy.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getLinterPolicyForCwd: () => null,
	markdownlintConfigArgs: () => [],
}));
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	logLatency: vi.fn(),
}));

describe("dbg", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});
	it("trace", async () => {
		const env = { tmpDir: "C:/Temp/dbg-ws" };
		fs.mkdirSync(env.tmpDir, { recursive: true });
		const filePath = path.join(env.tmpDir, "notes.md");
		fs.writeFileSync(filePath, "# hello\n");
		safeSpawnAsync.mockResolvedValue({
			error: null, status: null, stdout: "", stderr: "", failure: "timeout",
		});
		const cooldown = await import("../../clients/spawn-timeout-cooldown.js");
		const runnerMod = await import("../../clients/dispatch/runners/markdownlint.js");
		console.log("same module?", 
			(await import("../../clients/spawn-timeout-cooldown.js")) === cooldown);
		const runner = runnerMod.default;
		const result = await runner.run({
			filePath, cwd: env.tmpDir, kind: "markdown",
			pi: { getFlag: () => false }, autofix: false, deltaMode: true,
			hasTool: async () => true, log: () => {},
		} as never);
		console.log("status:", result.status, "| cooldown armed:",
			cooldown.isInSpawnTimeoutCooldown("markdownlint"),
			"| spawns:", safeSpawnAsync.mock.calls.length);
		expect(true).toBe(true);
	});
});
