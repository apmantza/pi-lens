import * as path from "node:path";
import { describe, expect, it } from "vitest";
import vitestConfig, { resolveVitestCacheDir } from "../../vitest.config.ts";
import mutationConfig from "../../vitest.mutation.config.ts";
import { stripCommentsAndStrings } from "../support/session-state-scan.js";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFiles,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const CONFIG_NAME = /^vite(st)?(\.[\w-]+)?\.(config|workspace)\.[cm]?[jt]s$/;

// The two per-worktree values the repo's configs use. Anything else, including a
// value the census cannot read, is unrecognized and reds.
const KNOWN_GOOD_VALUE =
	/fsModuleCachePath\s*:\s*(resolveVitestCacheDir\(\s*process\.cwd\(\)\s*\)|path\.join\(\s*root\s*,\s*["']\.vitest-cache["']\s*\))/y;

/**
 * True when the file has exactly one live `fsModuleCachePath` key and the value
 * at that key is a known-good form. The key is found on comment-and-string-blanked
 * text, which keeps offsets, and the value is read from the source at that offset,
 * so text quoted elsewhere in the file cannot satisfy it.
 */
function hasPerWorktreeCacheValue(source: string): boolean {
	const keys = [
		...stripCommentsAndStrings(source).matchAll(/\bfsModuleCachePath\s*:/g),
	];
	if (keys.length !== 1) return false;
	KNOWN_GOOD_VALUE.lastIndex = keys[0].index ?? 0;
	return KNOWN_GOOD_VALUE.test(source);
}

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
	it(
		"sets a per-worktree fsModuleCachePath in every Vitest config in the tree",
		() => {
			// The shared walker skips runtime scratch (.probe-home, .claude) that a
			// sibling worker deletes mid-walk (#4097); Greptile on f980bad20 found
			// the hand-rolled walk entering it.
			const configs = listSourceFiles(process.cwd(), {
				extensions: [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"],
			}).filter((file) => CONFIG_NAME.test(path.basename(file)));
			assertNonEmptyScan("Vitest configs in the tree", configs.length, 4);
			const unpinned = readWalkedFiles(configs)
				.filter(({ source }) => !hasPerWorktreeCacheValue(source))
				.map(({ file }) => path.relative(process.cwd(), file));
			expect(unpinned).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	// Recurrence: Greptile on f980bad20 showed a config whose live key points at
	// the shared cache passing, because the known-good text sat in a string
	// elsewhere in the file and the helper accepted any argument.
	it.each([
		[
			"a shared path with the good form quoted elsewhere",
			'const note = "fsModuleCachePath: path.join(root, \'.vitest-cache\')";\nexport default { test: { fsModuleCachePath: path.join(root, "node_modules", ".vitest-cache") } };',
		],
		[
			"the helper given another root",
			'export default { test: { fsModuleCachePath: resolveVitestCacheDir("/tmp/elsewhere") } };',
		],
		[
			"a second assignment after the good one",
			'export default { test: { fsModuleCachePath: resolveVitestCacheDir(process.cwd()), fsModuleCachePath: "/shared" } };',
		],
		["no key at all", "export default { test: {} };"],
	])("refuses %s", (_name, source) => {
		expect(hasPerWorktreeCacheValue(source)).toBe(false);
	});

	it.each([
		"export default { test: { fsModuleCachePath: resolveVitestCacheDir(process.cwd()) } };",
		'export default { test: { fsModuleCachePath: path.join(root, ".vitest-cache") } };',
	])("admits a known-good form: %s", (source) => {
		expect(hasPerWorktreeCacheValue(source)).toBe(true);
	});
});
