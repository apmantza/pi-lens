import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import vitestConfig, { resolveVitestCacheDir } from "../../vitest.config.ts";
import mutationConfig from "../../vitest.mutation.config.ts";
import { stripCommentsAndStrings } from "../support/session-state-scan.js";

describe("Vitest module cache roots (#5206)", () => {
	it("does not use the linked install's shared cache", () => {
		expect(vitestConfig.test?.fsModuleCachePath).toBe(
			resolveVitestCacheDir(process.cwd()),
		);
		expect(vitestConfig.test?.fsModuleCachePath).not.toBe(
			path.join(process.cwd(), "node_modules", ".vitest-cache"),
		);
		expect(vitestConfig.test?.fsModuleCachePath).toBe(
			path.join(process.cwd(), ".vitest-cache"),
		);
	});

	it("gives the mutation campaign's config the same per-worktree cache", () => {
		expect(mutationConfig.test?.fsModuleCachePath).toBe(
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

	// Recurrence: the round-3 verify found two fixture configs (tmp-teardown,
	// registry-teardown) still on the shared node_modules/.vitest-cache after both
	// root configs were fixed. Every Vitest config in the tree must set the key;
	// one that does not, wherever it lives, reds here.
	it("sets fsModuleCachePath in every Vitest config in the tree", () => {
		const configs: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (
					["node_modules", "dist", ".git", ".vitest-cache"].includes(entry.name)
				)
					continue;
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (/^vitest(\.[\w-]+)?\.config\.[cm]?ts$/.test(entry.name))
					configs.push(path.relative(process.cwd(), full));
			}
		};
		walk(process.cwd());
		expect(configs.length).toBeGreaterThanOrEqual(4);
		const missing = configs.filter(
			(file) =>
				!/\bfsModuleCachePath\s*:/.test(
					stripCommentsAndStrings(fs.readFileSync(file, "utf8")),
				),
		);
		expect(missing).toEqual([]);
	});
});
