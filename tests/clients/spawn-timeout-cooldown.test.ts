/**
 * Tests for the spawn-timeout cooldown seam (#1995).
 *
 * One wedged executable must consume at most ONE bounded failure budget per
 * edit: the availability verification, the autofix `--fix`, and the lint
 * runner all consult this seam, so a timeout recorded by any one lane cools
 * the command down for all of them within the session.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { safeSpawnAsync } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
}));

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	safeSpawnAsync,
}));

vi.mock(
	"../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<Record<string, unknown>>()),
		createAvailabilityChecker: (command: string) => ({
			isAvailable: () => true,
			isAvailableAsync: async () => true,
			getCommand: () => command,
		}),
		resolveToolCommandWithInstallFallback: async (
			_cwd: string,
			toolId: string,
		) => toolId,
		resolveAvailableOrInstall: async (_cwd: string, toolId: string) => toolId,
	}),
);

vi.mock("../../clients/tool-policy.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getLinterPolicyForCwd: () => null,
	markdownlintConfigArgs: () => [],
}));

import {
	_resetSpawnTimeoutCooldownForTests,
	isInSpawnTimeoutCooldown,
	noteSpawnTimeout,
} from "../../clients/spawn-timeout-cooldown.js";
import { detectFileChangedAfterCommand } from "../../clients/file-utils.js";
import { makeRunnerCtx } from "../support/runner-ctx.js";
import { setupTestEnvironment } from "./test-utils.js";

const TIMEOUT_RESULT = {
	error: null,
	status: null,
	stdout: "",
	stderr: "",
	failure: "timeout" as const,
};

describe("spawn-timeout cooldown seam (#1995)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		_resetSpawnTimeoutCooldownForTests();
	});

	it("note → cooldown hot; reset → cool", () => {
		expect(isInSpawnTimeoutCooldown("C:/ws/tools/markdownlint-cli2.cmd")).toBe(
			false,
		);
		noteSpawnTimeout({
			tool: "markdownlint",
			command: "C:/ws/tools/markdownlint-cli2.cmd",
			phase: "lint",
			durationMs: 15000,
		});
		expect(isInSpawnTimeoutCooldown("C:/ws/tools/markdownlint-cli2.cmd")).toBe(
			true,
		);
		_resetSpawnTimeoutCooldownForTests();
		expect(isInSpawnTimeoutCooldown("C:/ws/tools/markdownlint-cli2.cmd")).toBe(
			false,
		);
	});
});

describe("detectFileChangedAfterCommand consults the seam (#1995)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		_resetSpawnTimeoutCooldownForTests();
	});

	it("returns 0 WITHOUT spawning when the command is cooling down", async () => {
		const env = setupTestEnvironment("pi-lens-timeout-autofix-guard-");
		try {
			const filePath = path.join(env.tmpDir, "notes.md");
			fs.writeFileSync(filePath, "# hello\n");
			const wedged = path.join(env.tmpDir, "markdownlint-cli2.cmd");

			noteSpawnTimeout({
				tool: "markdownlint",
				command: wedged,
				phase: "availability",
			});

			// Red-first on pre-seam code: this call spawned the wedged command
			// again and paid a second 30s budget.
			const fixed = await detectFileChangedAfterCommand(
				filePath,
				wedged,
				["--fix", filePath],
				env.tmpDir,
				[1],
			);

			expect(fixed).toBe(0);
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("records a timeout when the autofix spawn times out", async () => {
		const env = setupTestEnvironment("pi-lens-timeout-autofix-note-");
		try {
			const filePath = path.join(env.tmpDir, "notes.md");
			fs.writeFileSync(filePath, "# hello\n");
			const cmd = path.join(env.tmpDir, "markdownlint-cli2.cmd");
			safeSpawnAsync.mockResolvedValue(TIMEOUT_RESULT);

			await detectFileChangedAfterCommand(
				filePath,
				cmd,
				["--fix", filePath],
				env.tmpDir,
				[1],
			);

			expect(isInSpawnTimeoutCooldown(cmd)).toBe(true);
		} finally {
			env.cleanup();
		}
	});
});

describe("markdownlint runner consults the seam (#1995)", () => {
	function createCtx(filePath: string, cwd: string) {
		return makeRunnerCtx(filePath, cwd);
	}

	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		_resetSpawnTimeoutCooldownForTests();
	});

	it("skips WITHOUT spawning when the resolved command is cooling down", async () => {
		const env = setupTestEnvironment("pi-lens-timeout-lint-guard-");
		try {
			const filePath = path.join(env.tmpDir, "notes.md");
			fs.writeFileSync(filePath, "# hello\n");
			// Prime the SAME module instance the freshly-imported runner binds
			// to: vi.resetModules re-evaluates the seam module per test.
			const cooldown = await import("../../clients/spawn-timeout-cooldown.js");
			cooldown.noteSpawnTimeout({
				tool: "markdownlint",
				command: "markdownlint-cli2",
				phase: "autofix",
			});
			console.log(
				"DBG armed:",
				cooldown.isInSpawnTimeoutCooldown("markdownlint-cli2"),
			);

			const runnerMod =
				await import("../../clients/dispatch/runners/markdownlint.js");
			const runner = runnerMod.default;
			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);
			console.log(
				"DBG status:",
				result.status,
				"| spawns:",
				safeSpawnAsync.mock.calls.map((c) => c[0]),
				"| armed after:",
				cooldown.isInSpawnTimeoutCooldown("markdownlint-cli2"),
			);

			expect(result.status).toBe("skipped");
			expect(result.semantic).toBe("none");
			expect(result.diagnostics).toHaveLength(0);
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("arms the cooldown when its own lint spawn times out", async () => {
		const env = setupTestEnvironment("pi-lens-timeout-lint-note-");
		try {
			const filePath = path.join(env.tmpDir, "notes.md");
			fs.writeFileSync(filePath, "# hello\n");
			safeSpawnAsync.mockResolvedValue(TIMEOUT_RESULT);

			const runner = (
				await import("../../clients/dispatch/runners/markdownlint.js")
			).default;
			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			// The runner's own parse lane treats an unreadable timeout honestly;
			// the invariant under test is that the NEXT invocation cannot spawn.
			const cooldown = await import("../../clients/spawn-timeout-cooldown.js");
			expect(cooldown.isInSpawnTimeoutCooldown("markdownlint-cli2")).toBe(true);
			void result;
		} finally {
			env.cleanup();
		}
	});
});
