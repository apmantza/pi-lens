import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn();
const ensureTool = vi.fn();

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
}));

vi.mock("../../../../clients/installer/index.js", () => ({
	ensureTool,
}));

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")>()),
	createAvailabilityChecker: (command: string) => ({
		isAvailableAsync: async () => true,
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
	return makeRunnerCtx(filePath, cwd, { kind });
}

describe("terraform/kotlin runners", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllEnvs();
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

	// tflint resolves `.tflint.hcl` from its own cwd and never walks parents, and
	// we run it from the edited file's directory — so without an explicit
	// --config a repo-root config silently governs nothing below the root.
	it("passes the nearest ancestor .tflint.hcl to tflint via --config", async () => {
		const env = setupTestEnvironment("pi-lens-tflint-runner-");
		try {
			const configPath = path.join(env.tmpDir, ".tflint.hcl");
			fs.writeFileSync(
				configPath,
				'plugin "terraform" {\n  enabled = true\n}\n',
			);
			const nestedDir = path.join(env.tmpDir, "infra", "stack");
			fs.mkdirSync(nestedDir, { recursive: true });
			const filePath = path.join(nestedDir, "main.tf");
			fs.writeFileSync(filePath, 'resource "aws_s3_bucket" "x" {}\n');

			safeSpawnAsync.mockResolvedValue({
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
				expect.arrayContaining([`--config=${configPath}`]),
				expect.objectContaining({ cwd: nestedDir }),
			);
		} finally {
			env.cleanup();
		}
	});

	// Nearest wins: a stack-local config overrides the repo-root one, the same
	// precedence tflint would apply if it walked parents itself.
	it("prefers the nearest .tflint.hcl over one further up", async () => {
		const env = setupTestEnvironment("pi-lens-tflint-runner-");
		try {
			fs.writeFileSync(path.join(env.tmpDir, ".tflint.hcl"), "config {}\n");
			const nestedDir = path.join(env.tmpDir, "infra", "stack");
			fs.mkdirSync(nestedDir, { recursive: true });
			const nearestConfig = path.join(env.tmpDir, "infra", ".tflint.hcl");
			fs.writeFileSync(nearestConfig, "config {}\n");
			const filePath = path.join(nestedDir, "main.tf");
			fs.writeFileSync(filePath, 'resource "aws_s3_bucket" "x" {}\n');

			safeSpawnAsync.mockResolvedValue({
				status: 0,
				stdout: JSON.stringify({ issues: [], errors: [] }),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/tflint.js")
			).default;

			await runner.run(createCtx("terraform", filePath, env.tmpDir) as never);

			const args = safeSpawnAsync.mock.calls[0][1] as string[];
			expect(args).toContain(`--config=${nearestConfig}`);
		} finally {
			env.cleanup();
		}
	});

	it("passes a .tflint.hcl sitting in the edited file's own directory", async () => {
		const env = setupTestEnvironment("pi-lens-tflint-runner-");
		try {
			const configPath = path.join(env.tmpDir, ".tflint.hcl");
			fs.writeFileSync(configPath, "config {}\n");
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

			await runner.run(createCtx("terraform", filePath, env.tmpDir) as never);

			const args = safeSpawnAsync.mock.calls[0][1] as string[];
			expect(args).toContain(`--config=${configPath}`);
		} finally {
			env.cleanup();
		}
	});

	// The false-positive risk of the nonzero-exit guard: tflint exits 2 when it
	// finds issues. Those findings are on stdout, so the guard must not eat them.
	it("parses findings from tflint's exit-2 issues-found status", async () => {
		const env = setupTestEnvironment("pi-lens-tflint-runner-");
		try {
			const filePath = path.join(env.tmpDir, "main.tf");
			fs.writeFileSync(filePath, 'resource "aws_s3_bucket" "x" {}\n');

			safeSpawnAsync.mockResolvedValue({
				status: 2,
				stdout: JSON.stringify({
					issues: [
						{
							rule: {
								name: "terraform_deprecated_interpolation",
								severity: "warning",
							},
							message: "Interpolation-only expressions are deprecated",
							range: { filename: "main.tf", start: { line: 1, column: 1 } },
						},
					],
					errors: [],
				}),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/tflint.js")
			).default;

			const result = await runner.run(
				createCtx("terraform", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("succeeded");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]).toMatchObject({
				line: 1,
				severity: "warning",
				rule: "terraform_deprecated_interpolation",
			});
		} finally {
			env.cleanup();
		}
	});

	it("passes no --config when no .tflint.hcl exists above the file", async () => {
		const env = setupTestEnvironment("pi-lens-tflint-runner-");
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

			await runner.run(createCtx("terraform", filePath, env.tmpDir) as never);

			const args = safeSpawnAsync.mock.calls[0][1] as string[];
			expect(args.some((a) => a.startsWith("--config"))).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	// TFLINT_CONFIG_FILE outranks a discovered config in tflint's own precedence,
	// and --config outranks the env var — so passing one would silently override
	// a deliberate choice.
	it("leaves TFLINT_CONFIG_FILE in charge when it is set", async () => {
		const env = setupTestEnvironment("pi-lens-tflint-runner-");
		try {
			fs.writeFileSync(path.join(env.tmpDir, ".tflint.hcl"), "config {}\n");
			const nestedDir = path.join(env.tmpDir, "infra");
			fs.mkdirSync(nestedDir, { recursive: true });
			const filePath = path.join(nestedDir, "main.tf");
			fs.writeFileSync(filePath, 'resource "aws_s3_bucket" "x" {}\n');
			vi.stubEnv("TFLINT_CONFIG_FILE", "/elsewhere/custom.hcl");

			safeSpawnAsync.mockResolvedValue({
				status: 0,
				stdout: JSON.stringify({ issues: [], errors: [] }),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/tflint.js")
			).default;

			await runner.run(createCtx("terraform", filePath, env.tmpDir) as never);

			const args = safeSpawnAsync.mock.calls[0][1] as string[];
			expect(args.some((a) => a.startsWith("--config"))).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	// tflint exits non-zero with an empty stdout whenever it never got as far as
	// linting — an uninitialized plugin in `.tflint.hcl`, an unreadable config, a
	// bad flag. safe-spawn reports that as `status: 1` with NO `error` (a nonzero
	// exit is not a spawn failure), so a guard keyed only on `error` reports a
	// clean run for a file tflint never looked at.
	it("skips when tflint exits non-zero without producing output", async () => {
		const env = setupTestEnvironment("pi-lens-tflint-runner-");
		try {
			const filePath = path.join(env.tmpDir, "main.tf");
			fs.writeFileSync(filePath, 'resource "aws_s3_bucket" "x" {}\n');

			safeSpawnAsync.mockResolvedValue({
				status: 1,
				stdout: "",
				stderr: 'Plugin "aws" not found. Did you run `tflint --init`?',
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/tflint.js")
			).default;

			const result = await runner.run(
				createCtx("terraform", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("skipped");
			expect(result.diagnostics).toEqual([]);
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
