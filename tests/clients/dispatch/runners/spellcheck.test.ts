import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawn = vi.fn();
const safeSpawnAsync = vi.fn();

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn,
	safeSpawnAsync,
}));

vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		createAvailabilityChecker: () => ({
			isAvailableAsync: async () => true,
			getCommand: () => "typos",
		}),
	}),
);

function createCtx(filePath: string, cwd: string) {
	return makeRunnerCtx(filePath, cwd, { kind: "markdown" });
}

describe("spellcheck runner", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawn.mockReset();
		safeSpawnAsync.mockReset();
	});

	// #2691: the typos spawn passed no `cwd`, so it ran under the extension
	// host's `process.cwd()` instead of `ctx.cwd` -- same shape as #1731
	// (sqlfluff). typos-cli itself derives its own effective config root from
	// the TARGET FILE's own canonicalized parent directory for a file
	// argument (typos-cli's `run_checks` does `path.canonicalize()` +
	// `cwd.pop()` before calling `engine.init_dir`, never reading
	// `std::env::current_dir()` for a file arg), so `typos.toml`/
	// `_typos.toml` discovery does not change with this fix. A narrower
	// behavioral edge remains: typos resolves `extend-exclude` glob patterns
	// against a literal "." root (`GitignoreBuilder::new(".")`), which IS the
	// process cwd -- so this is mostly a consistency fix (matches the
	// availability probe's cwd) plus a real fix for that edge case.
	it("spellcheck runner spawns typos with the dispatch context's cwd, not the host's (#2691)", async () => {
		const env = setupTestEnvironment("pi-lens-spellcheck-cwd-");
		try {
			const filePath = path.join(env.tmpDir, "README.md");
			fs.writeFileSync(filePath, "# hello\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: "",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/spellcheck.js")
			).default;

			await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(safeSpawnAsync).toHaveBeenCalled();
			const [, , options] = safeSpawnAsync.mock.calls[0] as [
				string,
				string[],
				{ cwd?: string } | undefined,
			];
			expect(options?.cwd).toBe(env.tmpDir);
		} finally {
			env.cleanup();
		}
	});
});
