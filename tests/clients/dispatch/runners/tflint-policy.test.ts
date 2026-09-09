import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn();
const ensureTool = vi.fn();
const getLinterPolicyForCwd = vi.fn();

vi.mock("../../../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));
vi.mock("../../../../clients/installer/index.js", () => ({ ensureTool }));
vi.mock("../../../../clients/tool-policy.js", () => ({
	getLinterPolicyForCwd,
}));

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")>()),
	createAvailabilityChecker: (command: string) => ({
		isAvailableAsync: async () => true,
		getCommand: () => command,
	}),
}));

function createCtx(filePath: string, cwd: string) {
	return makeRunnerCtx(filePath, cwd, { kind: "terraform" });
}

describe("tflint runner — linter policy", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		ensureTool.mockReset();
		getLinterPolicyForCwd.mockReset();
		getLinterPolicyForCwd.mockReturnValue({
			runnerNames: ["tflint"],
			preferredRunners: ["tflint"],
			defaultRunner: "tflint",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		});
	});

	// Every other dispatch runner gates on the project's linter policy before
	// spawning; tflint was the one that ignored it, so a project that elected a
	// different terraform linter still got tflint's findings on top.
	it("skips without spawning when policy prefers a different runner", async () => {
		const env = setupTestEnvironment("pi-lens-tflint-policy-");
		try {
			const filePath = path.join(env.tmpDir, "main.tf");
			fs.writeFileSync(filePath, 'resource "aws_s3_bucket" "x" {}\n');
			getLinterPolicyForCwd.mockReturnValue({
				runnerNames: ["tflint"],
				preferredRunners: [],
				defaultWhenUnconfigured: false,
				gate: "config-first",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/tflint.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("skipped");
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("runs when policy prefers tflint", async () => {
		const env = setupTestEnvironment("pi-lens-tflint-policy-");
		try {
			const filePath = path.join(env.tmpDir, "main.tf");
			fs.writeFileSync(filePath, 'resource "aws_s3_bucket" "x" {}\n');
			safeSpawnAsync.mockResolvedValue({
				status: 0,
				stdout: JSON.stringify({ issues: [], errors: [] }),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/tflint.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("succeeded");
			expect(safeSpawnAsync).toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("runs when no policy applies to the file", async () => {
		const env = setupTestEnvironment("pi-lens-tflint-policy-");
		try {
			const filePath = path.join(env.tmpDir, "main.tf");
			fs.writeFileSync(filePath, 'resource "aws_s3_bucket" "x" {}\n');
			getLinterPolicyForCwd.mockReturnValue(null);
			safeSpawnAsync.mockResolvedValue({
				status: 0,
				stdout: JSON.stringify({ issues: [], errors: [] }),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/tflint.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("succeeded");
			expect(safeSpawnAsync).toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});
});
