import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn((..._args: unknown[]) =>
	Promise.resolve({ error: null, status: 0, stdout: "", stderr: "" }),
);

vi.mock("../../../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")>()),
	createAvailabilityChecker: () => ({
		isAvailable: () => true,
		isAvailableAsync: async () => true,
		getCommand: () => "fish_indent",
	}),
}));

function createFishCtx(filePath: string, cwd: string) {
	return {
		filePath,
		cwd,
		kind: "fish",
		pi: { getFlag: () => false },
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

describe("fish-indent runner", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		safeSpawnAsync.mockImplementation((..._args: unknown[]) =>
			Promise.resolve({ error: null, status: 0, stdout: "", stderr: "" }),
		);
	});

	it("appliesTo fish only", async () => {
		const runner = (
			await import("../../../../clients/dispatch/runners/fish-indent.js")
		).default;
		expect(runner.appliesTo).toEqual(["fish"]);
	});

	it("returns succeeded with no diagnostics when file is already formatted", async () => {
		const env = setupTestEnvironment("pi-lens-fish-indent-");
		try {
			const filePath = path.join(env.tmpDir, "config.fish");
			fs.writeFileSync(filePath, "function greet\n    echo hello\nend\n");
			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: "",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/fish-indent.js")
			).default;
			const result = await runner.run(
				createFishCtx(filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("succeeded");
			expect(result.diagnostics).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("returns warning diagnostic when file needs formatting", async () => {
		const env = setupTestEnvironment("pi-lens-fish-indent-");
		try {
			const filePath = path.join(env.tmpDir, "config.fish");
			fs.writeFileSync(filePath, "function greet\necho hello\nend\n");
			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/fish-indent.js")
			).default;
			const result = await runner.run(
				createFishCtx(filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("succeeded");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.rule).toBe("fish-indent-unformatted");
			expect(result.diagnostics[0]?.fixable).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("returns blocking error diagnostic on parse failure (stderr present)", async () => {
		const env = setupTestEnvironment("pi-lens-fish-indent-");
		try {
			const filePath = path.join(env.tmpDir, "broken.fish");
			fs.writeFileSync(filePath, "function (\n");
			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: "broken.fish (line 1): Expected a command name\n",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/fish-indent.js")
			).default;
			const result = await runner.run(
				createFishCtx(filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0]?.rule).toBe("fish-indent-parse-error");
			expect(result.diagnostics[0]?.line).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	it("skips when fish_indent is not available", async () => {
		vi.doMock(
			"../../../../clients/dispatch/runners/utils/runner-helpers.js",
			() => ({
				createAvailabilityChecker: () => ({
					isAvailable: () => false,
					isAvailableAsync: async () => false,
					getCommand: () => null,
				}),
			}),
		);
		vi.resetModules();

		const runner = (
			await import("../../../../clients/dispatch/runners/fish-indent.js")
		).default;
		const env = setupTestEnvironment("pi-lens-fish-indent-");
		try {
			const filePath = path.join(env.tmpDir, "config.fish");
			fs.writeFileSync(filePath, "echo hello\n");
			const result = await runner.run(
				createFishCtx(filePath, env.tmpDir) as never,
			);
			expect(result.status).toBe("skipped");
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});
});
