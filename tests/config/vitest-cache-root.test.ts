import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import vitestConfig, { resolveVitestCacheDir } from "../../vitest.config.ts";

describe("Vitest module cache roots (#5206)", () => {
	it("does not use the linked install's shared cache", () => {
		expect(vitestConfig.cacheDir).toBe(resolveVitestCacheDir(process.cwd()));
		expect(vitestConfig.cacheDir).not.toBe(
			path.join(process.cwd(), "node_modules", ".vitest-cache"),
		);
	});

	it("separates cache directories for two worktree roots", () => {
		const cacheA = resolveVitestCacheDir(path.join(os.tmpdir(), "worktree-a"));
		const cacheB = resolveVitestCacheDir(path.join(os.tmpdir(), "worktree-b"));

		expect(cacheA).not.toBe(cacheB);
		expect(cacheA).toContain(path.join(os.tmpdir(), "pi-lens-vitest-cache"));
		expect(cacheB).toContain(path.join(os.tmpdir(), "pi-lens-vitest-cache"));
	});
});
