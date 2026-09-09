import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import type { FileKind } from "../../../../clients/file-kinds.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn();
const getLinterPolicyForCwd = vi.fn();

vi.mock("../../../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));

vi.mock("../../../../clients/tool-policy.js", () => ({
	getLinterPolicyForCwd,
	getAutofixCapability: () => ({
		toolSupportsFix: false,
		safePipelineAutofix: false,
		fixKind: "none",
	}),
}));

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")>()),
	createAvailabilityChecker: (command: string) => ({
		isAvailable: () => true,
		isAvailableAsync: async () => true,
		getCommand: () => command,
	}),
	resolveToolCommandWithInstallFallback: async (_cwd: string, toolId: string) =>
		toolId,
}));

function createCtx(kind: string, filePath: string, cwd: string) {
	return makeRunnerCtx(filePath, cwd, { kind: kind as FileKind });
}

// A nonzero exit is not a spawn failure, so `SpawnResult.error` is unset and
// only `status` distinguishes "clean" from "never ran". These three runners had
// no run() coverage when the shared `spawnFailedWithNoOutput` guard replaced
// their error-only check, so this file pins the behavior for each.
describe("runners treat a nonzero exit with no output as skipped", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		getLinterPolicyForCwd.mockReset();
		getLinterPolicyForCwd.mockReturnValue(null);
	});

	it("hadolint skips rather than reporting a clean Dockerfile", async () => {
		const env = setupTestEnvironment("pi-lens-hadolint-");
		try {
			const filePath = path.join(env.tmpDir, "Dockerfile");
			fs.writeFileSync(filePath, "FROM alpine:3.20\n");
			safeSpawnAsync.mockResolvedValue({
				status: 1,
				stdout: "",
				stderr: "hadolint: unrecognised option `--format'",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/hadolint.js")
			).default;

			const result = await runner.run(
				createCtx("dockerfile", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("skipped");
			expect(result.diagnostics).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	// htmlhint parses stdout OR stderr, so the guard is handed the same string
	// the parser gets. Output on either stream must still reach the parser.
	it("htmlhint skips only when both streams are empty", async () => {
		const env = setupTestEnvironment("pi-lens-htmlhint-");
		try {
			const filePath = path.join(env.tmpDir, "index.html");
			fs.writeFileSync(filePath, "<html><body></body></html>\n");
			safeSpawnAsync.mockResolvedValue({ status: 1, stdout: "", stderr: "" });

			const runner = (
				await import("../../../../clients/dispatch/runners/htmlhint.js")
			).default;

			const result = await runner.run(
				createCtx("html", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("skipped");
		} finally {
			env.cleanup();
		}
	});

	it("htmlhint still parses findings that arrive on stderr with a nonzero exit", async () => {
		const env = setupTestEnvironment("pi-lens-htmlhint-");
		try {
			const filePath = path.join(env.tmpDir, "index.html");
			fs.writeFileSync(filePath, "<html><body></body></html>\n");
			safeSpawnAsync.mockResolvedValue({
				status: 1,
				stdout: "",
				stderr: `${filePath}:1:1: Doctype must be declared first. [error/doctype-first]`,
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/htmlhint.js")
			).default;

			const result = await runner.run(
				createCtx("html", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.diagnostics.length).toBeGreaterThan(0);
		} finally {
			env.cleanup();
		}
	});

	it("detekt skips rather than reporting a clean Kotlin file", async () => {
		const env = setupTestEnvironment("pi-lens-detekt-");
		try {
			fs.writeFileSync(
				path.join(env.tmpDir, "detekt.yml"),
				"build:\n  maxIssues: 0\n",
			);
			const filePath = path.join(env.tmpDir, "Main.kt");
			fs.writeFileSync(filePath, 'fun main() { println("hi") }\n');
			safeSpawnAsync.mockResolvedValue({
				status: 1,
				stdout: "",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/detekt.js")
			).default;

			const result = await runner.run(
				createCtx("kotlin", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("skipped");
			expect(result.diagnostics).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("detekt still parses findings that arrive on stderr with a nonzero exit", async () => {
		const env = setupTestEnvironment("pi-lens-detekt-");
		try {
			fs.writeFileSync(
				path.join(env.tmpDir, "detekt.yml"),
				"build:\n  maxIssues: 0\n",
			);
			const filePath = path.join(env.tmpDir, "Main.kt");
			fs.writeFileSync(filePath, 'fun main() { println("hi") }\n');
			safeSpawnAsync.mockResolvedValue({
				status: 1,
				stdout: "",
				stderr: `${filePath}:1:1: warning: This expression contains a magic number [MagicNumber]\n`,
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/detekt.js")
			).default;

			const result = await runner.run(
				createCtx("kotlin", filePath, env.tmpDir) as never,
			);

			expect(result.status).not.toBe("skipped");
			expect(result.diagnostics.length).toBeGreaterThan(0);
		} finally {
			env.cleanup();
		}
	});
});
