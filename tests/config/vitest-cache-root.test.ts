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
		const cacheA = resolveVitestCacheDir("/worktrees/worktree-a");
		const cacheB = resolveVitestCacheDir("/worktrees/worktree-b");

		expect(cacheA).not.toBe(cacheB);
		expect(cacheA).toBe("/worktrees/worktree-a/.vitest-cache");
		expect(cacheB).toBe("/worktrees/worktree-b/.vitest-cache");
	});
});
