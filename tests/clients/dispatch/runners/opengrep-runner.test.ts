import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "../../test-utils.js";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));
vi.mock("../../../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));

// opengrep resolves to a stub command (installed/available).
vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	createAvailabilityChecker: () => ({
		isAvailableAsync: async () => true,
		getCommand: () => "opengrep-stub",
	}),
	resolveAvailableOrInstall: async () => "opengrep-stub",
}));

const ONE_FINDING = JSON.stringify({
	results: [
		{
			check_id: "rules.no-eval",
			path: "bad.js",
			start: { line: 1, col: 11 },
			extra: { message: "avoid eval", severity: "ERROR" },
		},
	],
});

function ctx(cwd: string) {
	return {
		filePath: path.join(cwd, "bad.js"),
		cwd,
		kind: "jsts" as const,
		pi: { getFlag: () => false }, // enabled via the local .opengrep.yml
		facts: {},
		log: () => {},
	};
}

describe("opengrep runner — content+config cache (#111)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeEach(() => {
		safeSpawnAsync.mockReset();
		safeSpawnAsync.mockImplementation(async () => ({
			error: null,
			status: 0,
			stdout: ONE_FINDING,
			stderr: "",
		}));
		env = setupTestEnvironment("pi-lens-opengrep-");
		fs.writeFileSync(path.join(env.tmpDir, ".opengrep.yml"), "rules: []\n");
		fs.writeFileSync(path.join(env.tmpDir, "bad.js"), "const x = eval('1');\n");
	});

	async function freshRunner() {
		const mod = await import(
			"../../../../clients/dispatch/runners/opengrep.js"
		);
		mod._resetOpengrepCacheForTests();
		return mod.default;
	}

	it("scans and maps a finding to a diagnostic", async () => {
		try {
			const runner = await freshRunner();
			const res = await runner.run(ctx(env.tmpDir) as never);
			expect(res.diagnostics).toHaveLength(1);
			expect(res.diagnostics[0].rule).toBe("rules.no-eval");
			expect(res.diagnostics[0].line).toBe(1);
			expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		} finally {
			env.cleanup();
		}
	});

	it("returns cached diagnostics without re-spawning when content is unchanged", async () => {
		try {
			const runner = await freshRunner();
			await runner.run(ctx(env.tmpDir) as never);
			expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

			const second = await runner.run(ctx(env.tmpDir) as never);
			expect(second.diagnostics).toHaveLength(1);
			expect(safeSpawnAsync).toHaveBeenCalledTimes(1); // cache hit
		} finally {
			env.cleanup();
		}
	});

	it("re-spawns after the file content changes (cache miss)", async () => {
		try {
			const runner = await freshRunner();
			await runner.run(ctx(env.tmpDir) as never);
			expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

			// A real edit changes the content hash → cache misses.
			fs.writeFileSync(
				path.join(env.tmpDir, "bad.js"),
				"const y = eval('2');\nconst z = 3;\n",
			);
			await runner.run(ctx(env.tmpDir) as never);
			expect(safeSpawnAsync).toHaveBeenCalledTimes(2);
		} finally {
			env.cleanup();
		}
	});
});
