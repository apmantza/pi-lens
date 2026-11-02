import { defineConfig } from "vitest/config";
import { resolveVitestCacheDir, sharedGlobalSetup } from "./vitest.config.js";

// #4365: the per-test mutation campaign's vitest config. The Stryker vitest
// runner forces `pool: "threads"`, which rejects the `execArgv` every project in
// vitest.config.ts sets, so the campaign reads this single flat project instead.
// It runs ONLY the files the driver names (scripts/stryker-pertest.mjs, via
// PILENS_MUTATION_TESTS), under the same globalSetup and setup file the suite uses.
const files = (process.env.PILENS_MUTATION_TESTS ?? "")
	.split(",")
	.filter(Boolean);

export default defineConfig({
	test: {
		include: files.length > 0 ? files : ["tests/no-such-file.test.ts"],
		globalSetup: sharedGlobalSetup,
		// Same per-worktree module cache as vitest.config.ts (#5206).
		fsModuleCachePath: resolveVitestCacheDir(process.cwd()),
		setupFiles: ["./tests/support/vitest-setup.ts"],
		teardownTimeout: 30_000,
	},
});
