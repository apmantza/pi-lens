// Child Vitest run for tests/support/tmp-root-teardown.test.ts (#2912). It runs
// the fixture files beside it through the REAL shared setup file in the default
// forks pool, so each file's worker is torn down exactly as the suite's are:
// the pool SIGTERMs the fork after its afterAll.
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../../..", import.meta.url));

export default defineConfig({
	test: {
		root,
		// The worktree's own module cache, never the linked install's (#5206).
		fsModuleCachePath: path.join(root, ".vitest-cache"),
		include: ["tests/fixtures/tmp-teardown/*.fixture.ts"],
		setupFiles: ["./tests/support/vitest-setup.ts"],
		maxWorkers: 4,
	},
});
