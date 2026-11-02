// Child Vitest run for tests/support/vitest-setup-registry-teardown.test.ts
// (#3617, #3703). It runs the two fixture files below through the REAL
// shared setup file in the default forks pool, so each file's worker is
// torn down exactly as the suite's are.
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../../..", import.meta.url));

export default defineConfig({
	test: {
		root,
		// The worktree's own module cache, never the linked install's (#5206).
		fsModuleCachePath: path.join(root, ".vitest-cache"),
		include: ["tests/fixtures/registry-teardown/*.fixture.ts"],
		setupFiles: ["./tests/support/vitest-setup.ts"],
		maxWorkers: 2,
	},
});
