import * as path from "node:path";
import { describe, expect, it } from "vitest";
import vitestConfig, { resolveVitestCacheDir } from "../../vitest.config.ts";

describe("Vitest module cache roots (#5206)", () => {
	it("does not use the linked install's shared cache", () => {
		expect(vitestConfig.cacheDir).toBe(resolveVitestCacheDir(process.cwd()));
		expect(vitestConfig.cacheDir).not.toBe(
			path.join(process.cwd(), "node_modules", ".vitest-cache"),
		);
		expect(vitestConfig.cacheDir).toBe(
			path.join(process.cwd(), ".vitest-cache"),
		);
	});

	it("separates cache directories for two worktree roots", () => {
		// Host path functions: on Windows the roots resolve to a drive letter
		// and backslashes, so POSIX literals would red the required job.
		const rootA = path.resolve("worktrees", "worktree-a");
		const rootB = path.resolve("worktrees", "worktree-b");
		const cacheA = resolveVitestCacheDir(rootA);
		const cacheB = resolveVitestCacheDir(rootB);

		expect(cacheA).not.toBe(cacheB);
		expect(path.dirname(cacheA)).toBe(rootA);
		expect(path.dirname(cacheB)).toBe(rootB);
		expect(path.basename(cacheA)).toBe(".vitest-cache");
	});
});
