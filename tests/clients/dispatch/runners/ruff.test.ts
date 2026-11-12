import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawn = vi.fn();
const safeSpawnAsync = vi.fn();
const ensureTool = vi.fn(async (_toolId: string) => "ruff");
const resolveToolCommandWithInstallFallback = vi.fn(async () =>
	ensureTool("ruff"),
);

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn,
	safeSpawnAsync,
}));

vi.mock("../../../../clients/installer/index.js", () => ({
	ensureTool,
}));

vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		resolveToolCommandWithInstallFallback,
	}),
);

function createCtx(filePath: string, cwd: string) {
	return makeRunnerCtx(filePath, cwd, { kind: "python" });
}

describe("ruff runner", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawn.mockReset();
		safeSpawnAsync.mockReset();
		ensureTool.mockReset();
		ensureTool.mockResolvedValue("ruff");
		// Simulate ruff not being available on PATH/venv so ensureTool path is used.
		safeSpawn.mockReturnValue({ error: new Error("not found"), status: 1 });
	});

	it("runs diagnostics-only check without mutating file", async () => {
		const env = setupTestEnvironment("pi-lens-ruff-runner-");
		try {
			const filePath = path.join(env.tmpDir, "sample.py");
			fs.writeFileSync(filePath, "import os\n");

			safeSpawnAsync
				.mockResolvedValueOnce({
					error: new Error("not found"),
					status: 1,
					stdout: "",
					stderr: "",
				})
				.mockResolvedValueOnce({
					error: null,
					status: 1,
					stdout: "[]",
					stderr: "",
				});

			const runner = (
				await import("../../../../clients/dispatch/runners/ruff.js")
			).default;

			await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(ensureTool).toHaveBeenCalledWith("ruff");
			const ruffCalls = safeSpawnAsync.mock.calls
				.filter((call) => call[0] === "ruff")
				.map((call) => call[1] as string[]);
			expect(
				ruffCalls.some(
					(args) =>
						args.includes("check") &&
						args.includes("--output-format") &&
						args.includes("json") &&
						args.includes(filePath),
				),
			).toBe(true);
			expect(ruffCalls.some((args) => args.includes("--fix"))).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("does not turn nonzero empty or unparsable output into clean (#1816)", async () => {
		const env = setupTestEnvironment("pi-lens-ruff-outcome-");
		try {
			const filePath = path.join(env.tmpDir, "sample.py");
			fs.writeFileSync(filePath, "import os\n");
			const runner = (
				await import("../../../../clients/dispatch/runners/ruff.js")
			).default;

			for (const stdout of ["", "ruff emitted non-JSON failure output"]) {
				safeSpawnAsync.mockResolvedValueOnce({
					error: null,
					status: 1,
					stdout,
					stderr: "",
				});
				const result = await runner.run(
					createCtx(filePath, env.tmpDir) as never,
				);
				expect(result.status).not.toBe("succeeded");
				if (stdout) expect(result.diagnostics.length).toBeGreaterThan(0);
			}
		} finally {
			env.cleanup();
		}
	});

	it("preserves valid findings on status 2 (#1816)", async () => {
		const env = setupTestEnvironment("pi-lens-ruff-status-2-findings-");
		try {
			const filePath = path.join(env.tmpDir, "sample.py");
			fs.writeFileSync(filePath, "import os\n");
			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 2,
				stdout: JSON.stringify([
					{
						code: "F401",
						message: "unused import",
						filename: filePath,
						location: { row: 1, column: 1 },
					},
				]),
				stderr: "",
			});
			const runner = (
				await import("../../../../clients/dispatch/runners/ruff.js")
			).default;
			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("succeeded");
			expect(result.diagnostics).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	// #2691: the check spawn passed no `cwd`, so a nested `pyproject.toml`
	// config was resolved against the extension host's `process.cwd()`
	// instead of `ctx.cwd` -- same shape as #1731 (sqlfluff), even though
	// ruff itself walks upward from the linted FILE's own directory for
	// `pyproject.toml`/`ruff.toml` discovery (ruff_workspace's
	// `find_settings_toml` iterates `path.ancestors()` of the target path,
	// not the process cwd), so this is a consistency fix that keeps the lint
	// spawn's cwd aligned with the availability probe and `ruffConfigArgs`,
	// not a config-resolution behavior change.
	it("ruff runner spawns the check with the dispatch context's cwd, not the host's (#2691)", async () => {
		const env = setupTestEnvironment("pi-lens-ruff-cwd-");
		try {
			const filePath = path.join(env.tmpDir, "sample.py");
			fs.writeFileSync(filePath, "import os\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: "[]",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/ruff.js")
			).default;

			await runner.run(createCtx(filePath, env.tmpDir) as never);

			const checkCall = safeSpawnAsync.mock.calls.find((call) =>
				(call[1] as string[]).includes("check"),
			) as [string, string[], { cwd?: string } | undefined];
			expect(checkCall).toBeDefined();
			expect(checkCall[2]?.cwd).toBe(env.tmpDir);
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #5412 round 2: a finding with a rule keeps its id, `ruff-<code>`. The message
 * digest belongs to the rule-less branch only. Recurrence: the r1 review,
 * where `id: rule` -> `id: (rule && message.length < 0)` survived the go-vet and
 * ruff tests, so every ruff id, and every delta baseline keyed on it, could
 * change without a red.
 */
describe("ruff findings keep their rule id (#5412)", () => {
	it("gives a ruled ruff finding the id ruff-<code>, with no message digest", async () => {
		// Dynamic import: the file's vi.mock factories read top-level consts, so a
		// static import of the parser would evaluate safe-spawn too early.
		const { parseRuffOutput } =
			await import("../../../../clients/dispatch/runners/utils/diagnostic-parsers.js");
		const diags = parseRuffOutput(
			"a.py:3:1: F401 `os` imported but unused\n",
			"/proj/a.py",
			"/proj",
		);
		expect(diags).toHaveLength(1);
		expect(diags[0]?.rule).toBe("F401");
		expect(diags[0]?.id).toBe("ruff-F401");
	});
});
