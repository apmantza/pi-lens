import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn();
const ensureTool = vi.fn();

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
}));

vi.mock("../../../../clients/installer/index.js", () => ({
	ensureTool,
}));

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	createAvailabilityChecker: (command: string) => ({
		isAvailable: () => true,
		getCommand: () => command,
	}),
	resolveToolCommandWithInstallFallback: vi.fn(
		async (_cwd: string, toolId: string) => toolId,
	),
}));

function createCtx(
	kind: "terraform" | "kotlin",
	filePath: string,
	cwd: string,
) {
	return {
		filePath,
		cwd,
		kind,
		pi: { getFlag: () => false },
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

describe("terraform/kotlin runners", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		ensureTool.mockReset();
	});

	it("runs tflint from the edited file directory", async () => {
		const env = setupTestEnvironment("pi-lens-tflint-runner-");
		try {
			const nestedDir = path.join(env.tmpDir, "infra", "stack");
			fs.mkdirSync(nestedDir, { recursive: true });
			const filePath = path.join(nestedDir, "main.tf");
			fs.writeFileSync(filePath, 'resource "aws_s3_bucket" "x" {}\n');

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: JSON.stringify({ issues: [], errors: [] }),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/tflint.js")
			).default;

			await runner.run(createCtx("terraform", filePath, env.tmpDir) as never);

			expect(safeSpawnAsync).toHaveBeenCalledWith(
				"tflint",
				expect.arrayContaining([
					"--format=json",
					"--no-color",
					"--filter=main.tf",
				]),
				expect.objectContaining({ cwd: nestedDir }),
			);
		} finally {
			env.cleanup();
		}
	});

	it("surfaces unparseable ktlint output instead of reporting a clean run", async () => {
		const env = setupTestEnvironment("pi-lens-ktlint-runner-");
		try {
			const filePath = path.join(env.tmpDir, "Main.kt");
			fs.writeFileSync(filePath, 'fun main() { println("hi") }\n');

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: '{"unexpected":true}',
				stderr: "wrapper noise",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/ktlint.js")
			).default;

			const result = await runner.run(
				createCtx("kotlin", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.message).toContain(
				"Unable to parse ktlint output",
			);
		} finally {
			env.cleanup();
		}
	});
});
