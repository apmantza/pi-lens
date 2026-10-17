import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Directories {@link walkFiles} never descends into: runtime scratch and
 * third-party trees that hold no repo source and that sibling processes
 * create and delete while a sweep walks. Named recurrence (#4097): the
 * bounded-container guard walked the repo root, `.probe-home/` included, and
 * died with ENOENT when a sibling vitest worker removed its
 * `worker-home-*` mid-walk. Matched by directory name at any depth below the
 * walk root (the root itself is always walked).
 */
export const RUNTIME_SCRATCH_DIRS = new Set([
	".git",
	".probe-home",
	".claude",
	"node_modules",
]);

/**
 * The one recursive repo walker: every non-directory entry under `root` that
 * `accept(entry, absolutePath)` keeps, as absolute paths in sorted order
 * (`readdirSync` order is not a contract). `scripts/` cannot import
 * `tests/support/sweep-kit.ts`, so the test-side `listSourceFiles` and the
 * win32 gate population both walk through this (#4104).
 *
 * A non-root directory that vanished between its parent's listing and its
 * own (#4097) is out of the population: `onVanishedDirectory` is told, and
 * the walk goes on. The callback is required so the skip is always recorded
 * (AGENTS.md shape 10). The root must exist: a missing root, and any error
 * other than ENOENT, throw.
 */
export function walkFiles(root, accept, onVanishedDirectory) {
	const walk = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			if (dir === root || error?.code !== "ENOENT") throw error;
			onVanishedDirectory(dir);
			return [];
		}
		return entries.flatMap((entry) => {
			const entryPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				return RUNTIME_SCRATCH_DIRS.has(entry.name) ? [] : walk(entryPath);
			}
			return accept(entry, entryPath) ? [entryPath] : [];
		});
	};
	return walk(root).sort();
}
