import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "../../test-utils.js";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));
vi.mock("../../../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));
vi.mock("../../../../clients/installer/index.js", () => ({
	ensureTool: vi.fn(async () => "shfmt"),
}));
vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	createAvailabilityChecker: () => ({
		isAvailableAsync: async () => true,
		getCommand: () => "shfmt",
	}),
}));

function ctx(filePath: string, cwd: string) {
	return {
		filePath,
		cwd,
		kind: "shell" as const,
		pi: { getFlag: () => false },
		facts: { },
		log: () => {},
	};
}

// #211: the format-diff WARNING must be gated on .editorconfig (shfmt's only
// config source) so it doesn't nag every unformatted shell write; PARSE ERRORS
// must always be reported.
describe("shfmt runner — format-diff warning is .editorconfig-gated (#211)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let filePath: string;

	beforeEach(() => {
		safeSpawnAsync.mockReset();
		env = setupTestEnvironment("pi-lens-shfmt-");
		filePath = path.join(env.tmpDir, "script.sh");
		fs.writeFileSync(filePath, "echo hi\n");
	});

	async function run() {
		const runner = (
			await import("../../../../clients/dispatch/runners/shfmt.js")
		).default;
		return runner.run(ctx(filePath, env.tmpDir) as never);
	}

	it("does NOT warn on an unformatted file when no .editorconfig exists", async () => {
		safeSpawnAsync.mockResolvedValue({ error: null, status: 1, stdout: "@@ -1 +1 @@\n-x\n+x\n", stderr: "" });
		try {
			const result = await run();
			expect(result.diagnostics).toHaveLength(0);
			expect(result.semantic).toBe("none");
		} finally {
			env.cleanup();
		}
	});

	it("warns on an unformatted file when .editorconfig opts in", async () => {
		fs.writeFileSync(path.join(env.tmpDir, ".editorconfig"), "[*.sh]\nindent_size = 2\n");
		safeSpawnAsync.mockResolvedValue({ error: null, status: 1, stdout: "@@ -3 +3 @@\n", stderr: "" });
		try {
			const result = await run();
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0].rule).toBe("shfmt-unformatted");
			expect(result.diagnostics[0].line).toBe(3);
		} finally {
			env.cleanup();
		}
	});

	it("ALWAYS reports parse errors, even without .editorconfig", async () => {
		safeSpawnAsync.mockResolvedValue({ error: null, status: 2, stdout: "", stderr: "script.sh:2:1: syntax error\n" });
		try {
			const result = await run();
			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0].rule).toBe("shfmt-parse-error");
		} finally {
			env.cleanup();
		}
	});
});
