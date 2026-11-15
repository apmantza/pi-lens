// Child Vitest run for tests/support/real-spawn-observer.test.ts (#5100). It
// runs the fixture files beside it through the REAL shared setup file in the
// forks pool, so each fixture's worker loads the spawn observer and answers at
// its own teardown exactly as a suite file does.
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../../..", import.meta.url));

export default defineConfig({
	test: {
		root,
		// The worktree's own module cache, never the linked install's (#5206).
		fsModuleCachePath: path.join(root, ".vitest-cache"),
		include: ["tests/fixtures/real-spawn-gate/*.fixture.ts"],
		setupFiles: ["./tests/support/vitest-setup.ts"],
		maxWorkers: 2,
	},
});
