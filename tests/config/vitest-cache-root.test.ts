import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import vitestConfig, { resolveVitestCacheDir } from "../../vitest.config.ts";
import mutationConfig from "../../vitest.mutation.config.ts";
import { stripCommentsAndStrings } from "../support/session-state-scan.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

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
	// root configs were fixed, and round 4 showed a key pointing back at the shared
	// directory passed a presence check. Every Vitest or Vite config in the tree,
	// in any spelling, must set the key to one of the two known-good forms;
	// anything else, including a value the census cannot read, reds here.
	it("sets a per-worktree fsModuleCachePath in every Vitest config in the tree", () => {
		const configs: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (["node_modules", ".git", ".vitest-cache"].includes(entry.name))
					continue;
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (
					/^vite(st)?(\.[\w-]+)?\.(config|workspace)\.[cm]?[jt]s$/.test(
						entry.name,
					)
				)
					configs.push(path.relative(process.cwd(), full));
			}
		};
		walk(process.cwd());
		assertNonEmptyScan("Vitest configs in the tree", configs.length, 4);
		const knownGood =
			/\bfsModuleCachePath\s*:\s*(resolveVitestCacheDir\(|path\.join\(\s*root\s*,\s*["']\.vitest-cache["']\s*\))/;
		const unpinned = configs.filter((file) => {
			const source = fs.readFileSync(file, "utf8");
			const code = source
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/(^|[^:"'])\/\/.*$/gm, "$1");
			return (
				!/\bfsModuleCachePath\s*:/.test(stripCommentsAndStrings(source)) ||
				!knownGood.test(code)
			);
		});
		expect(unpinned).toEqual([]);
	});
});
