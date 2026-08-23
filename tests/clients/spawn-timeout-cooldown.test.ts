/**
 * Tests for the spawn-timeout cooldown seam (#1995).
 *
 * One wedged executable must consume at most ONE bounded failure budget per
 * edit: the availability verification, the autofix `--fix`, and the lint
 * runner all consult this seam, so a timeout recorded by any one lane cools
 * the command down for all of them within the session.
 *
 * IMPORTANT (shape 14): every test obtains the seam via DYNAMIC IMPORT after
 * any `vi.resetModules()`, and the code under test resolves its own import in
 * the same epoch — module instances re-evaluate across resets, so a
 * statically-bound copy would prime/assert a DIFFERENT map than the runner's.
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
	}),
);

vi.mock("../../clients/tool-policy.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getLinterPolicyForCwd: () => null,
	markdownlintConfigArgs: () => [],
}));
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

async function seam() {
	return await import("../../clients/spawn-timeout-cooldown.js");
}

describe("seam unit semantics", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});

	it("note → cooldown hot; reset → cool", async () => {
		const {
			isInSpawnTimeoutCooldown,
			noteSpawnTimeout,
			resetSpawnTimeoutCooldowns,
		} = await seam();
		const cmd = "C:/ws/tools/markdownlint-cli2.cmd";
		expect(isInSpawnTimeoutCooldown(cmd)).toBe(false);
		noteSpawnTimeout({
			tool: "markdownlint",
			command: cmd,
			phase: "lint",
			durationMs: 15000,
		});
		expect(isInSpawnTimeoutCooldown(cmd)).toBe(true);
		resetSpawnTimeoutCooldowns();
		expect(isInSpawnTimeoutCooldown(cmd)).toBe(false);
	});
});

describe("detectFileChangedAfterCommand consults the seam", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});

	it("returns 0 WITHOUT spawning when the command is cooling down", async () => {
		const env = setupTestEnvironment("pi-lens-timeout-autofix-guard-");
		try {
			const filePath = path.join(env.tmpDir, "notes.md");
			fs.writeFileSync(filePath, "# hello\n");
			const wedged = path.join(env.tmpDir, "markdownlint-cli2.cmd");
			const { noteSpawnTimeout } = await seam();
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

			const { isInSpawnTimeoutCooldown } = await seam();
			expect(isInSpawnTimeoutCooldown(cmd)).toBe(true);
		} finally {
			env.cleanup();
		}
	});
});

describe("tryMarkdownlintFix consults the seam (review P2)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});

	it("returns 0 WITHOUT spawning when its resolved command is cooling down", async () => {
		const env = setupTestEnvironment("pi-lens-timeout-pipeline-guard-");
		try {
			const filePath = path.join(env.tmpDir, "notes.md");
			fs.writeFileSync(filePath, "# hello\n");
			const { noteSpawnTimeout } = await seam();
			// The mocked resolver returns the bare tool id; in production both
			// lanes resolve the same physical binary, and basename-level
			// keying is what makes different spellings cross-cool.
			noteSpawnTimeout({
				tool: "markdownlint",
				command: "markdownlint",
				phase: "availability",
			});

			const pipeline = await import("../../clients/pipeline.js");
			const fixed = await pipeline.tryMarkdownlintFix(filePath, env.tmpDir);

			expect(fixed).toBe(0);
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});
});

describe("cross-lane key sharing (review P2)", () => {
	it("a PATH-resolved absolute timeout cools differently-spelled resolvations", async () => {
		const {
			isInSpawnTimeoutCooldown,
			noteSpawnTimeout,
			resetSpawnTimeoutCooldowns,
		} = await seam();
		resetSpawnTimeoutCooldowns();
		noteSpawnTimeout({
			tool: "markdownlint",
			command: "C:/Users/x/AppData/npm/markdownlint-cli2.cmd",
			phase: "lint",
		});
		// Lanes resolve the same binary through different helpers and may hold
		// different strings (PATH absolute vs cwd .bin shim vs bare name);
		// basename-level keying must match all of them.
		expect(isInSpawnTimeoutCooldown("markdownlint-cli2")).toBe(true);
		expect(
			isInSpawnTimeoutCooldown("C:/ws/node_modules/markdownlint-cli2"),
		).toBe(true);
		void resetSpawnTimeoutCooldowns;
	});
});

describe("markdownlint runner consults the seam", () => {
	function createCtx(filePath: string, cwd: string) {
		return makeRunnerCtx(filePath, cwd);
	}

	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});

	it("skips WITHOUT spawning when the resolved command is cooling down", async () => {
		const env = setupTestEnvironment("pi-lens-timeout-lint-guard-");
		try {
			const filePath = path.join(env.tmpDir, "notes.md");
			fs.writeFileSync(filePath, "# hello\n");
			const { noteSpawnTimeout } = await seam();
			noteSpawnTimeout({
				tool: "markdownlint",
				command: "markdownlint-cli2",
				phase: "autofix",
			});

			const runner = (
				await import("../../clients/dispatch/runners/markdownlint.js")
			).default;
			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

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
			await runner.run(createCtx(filePath, env.tmpDir) as never);

			const { isInSpawnTimeoutCooldown } = await seam();
			expect(isInSpawnTimeoutCooldown("markdownlint-cli2")).toBe(true);
		} finally {
			env.cleanup();
		}
	});
});
