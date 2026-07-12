import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawn = vi.fn();
const safeSpawnAsync = vi.fn();
const ensureTool = vi.fn(async (_toolId?: string) => "oxlint");

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn,
	safeSpawnAsync,
}));

vi.mock("../../../../clients/installer/index.js", () => ({
	ensureTool,
}));

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	resolveToolCommand: vi.fn(() => null),
	resolveToolCommandWithInstallFallback: vi.fn(async (_cwd: string) => {
		const installed = await ensureTool("oxlint");
		return installed ?? null;
	}),
}));

function createCtx(filePath: string, cwd: string) {
	return makeRunnerCtx(filePath, cwd);
}

describe("oxlint runner", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawn.mockReset();
		safeSpawnAsync.mockReset();
		ensureTool.mockReset();
		ensureTool.mockResolvedValue("oxlint");
		// Simulate oxlint not being available on PATH/venv so ensureTool path is used.
		safeSpawn.mockReturnValue({ error: new Error("not found"), status: 1 });
	});

	it("auto-installs and runs oxlint as the no-config JS/TS fallback", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-runner-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "console.log('hi')\n");

			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: JSON.stringify({
					diagnostics: [
						{
							message: "Unexpected console statement",
							code: "eslint(no-console)",
							severity: "warning",
							help: "Replace console.log with a logger",
							filename: filePath,
							labels: [{ span: { line: 1, column: 1 } }],
						},
					],
				}),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.ts")
			).default;

			// hasTool returns false → triggers resolveToolCommandWithInstallFallback → ensureTool
			const result = await runner.run({ ...createCtx(filePath, env.tmpDir), hasTool: async () => false } as never);

			expect(ensureTool).toHaveBeenCalledWith("oxlint");
			expect(safeSpawnAsync).toHaveBeenCalledWith(
				"oxlint",
				expect.arrayContaining(["--format", "json", filePath]),
				expect.objectContaining({ timeout: 30000 }),
			);
			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]).toMatchObject({
				tool: "oxlint",
				rule: "no-console",
				line: 1,
				fixSuggestion: "Replace console.log with a logger",
			});
		} finally {
			env.cleanup();
		}
	});

	it("skips when ESLint is explicitly configured", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-eslint-config-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const x = 1\n");
			fs.writeFileSync(path.join(env.tmpDir, ".eslintrc.json"), "{}\n");

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.ts")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("skipped");
			expect(ensureTool).not.toHaveBeenCalled();
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("falls back to plain oxlint when Vite+ is configured but vp is not installed", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-vite-plus-fallback-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "console.log('hi')\n");
			fs.writeFileSync(
				path.join(env.tmpDir, "package.json"),
				JSON.stringify({ devDependencies: { "vite-plus": "^0.1.0" } }),
			);

			// First call: vp --version (not found)
			// Second call: oxlint --format unix <file> (success, no issues)
			safeSpawnAsync
				.mockResolvedValueOnce({
					error: new Error("not found"),
					status: 1,
					stdout: "",
					stderr: "",
				})
				.mockResolvedValueOnce({
					error: null,
					status: 0,
					stdout: "",
					stderr: "",
				});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.ts")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(safeSpawnAsync).toHaveBeenCalledWith(
				"vp",
				["--version"],
				expect.objectContaining({ timeout: 5000 }),
			);
			expect(safeSpawnAsync).toHaveBeenCalledWith(
				"oxlint",
				expect.arrayContaining(["--format", "json", filePath]),
				expect.objectContaining({ timeout: 30000 }),
			);
			expect(result.status).toBe("succeeded");
		} finally {
			env.cleanup();
		}
	});

	it("promotes severity=error diagnostics to blocking semantic", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-error-promotion-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "debugger;\n");

			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: JSON.stringify({
					diagnostics: [
						{
							message: "`debugger` statement is not allowed",
							code: "eslint(no-debugger)",
							severity: "error",
							help: "Remove the debugger statement",
							filename: filePath,
							labels: [{ span: { line: 1, column: 1 } }],
						},
					],
				}),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.ts")
			).default;
			const result = await runner.run({ ...createCtx(filePath, env.tmpDir), hasTool: async () => false } as never);

			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0]).toMatchObject({
				severity: "error",
				semantic: "blocking",
				rule: "no-debugger",
				fixSuggestion: "Remove the debugger statement",
			});
		} finally {
			env.cleanup();
		}
	});

	it("falls back to unix-format parsing when oxlint emits non-JSON output", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-fallback-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "console.log('hi')\n");

			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: `${filePath}:1:1: Unexpected console statement (no-console)\n`,
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.ts")
			).default;
			const result = await runner.run({ ...createCtx(filePath, env.tmpDir), hasTool: async () => false } as never);

			expect(result.status).toBe("failed");
			expect(result.diagnostics[0]).toMatchObject({
				tool: "oxlint",
				rule: "no-console",
				line: 1,
			});
			// Unix fallback has no fix info — fixSuggestion is absent here.
			expect(result.diagnostics[0].fixSuggestion).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});
