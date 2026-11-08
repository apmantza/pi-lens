// flake-shape: real-process-spawn — the cold-vs-warm cell needs a real Git index: `ensureTrackedIndex()` runs `git ls-files`, and a tracked-but-gitignored file is only tracked by a repository Git itself wrote; an in-process double would restate the answer the cell asserts
/**
 * #5371 r2 F5: the shared `paths` reader returns the same set on a cold call
 * and a warm call, because the glob walk primes the tracked index before it
 * reads the ignore decision.
 *
 * RECURRENCE GUARDED (#5393 review F5): the walk never awaited
 * `ensureTrackedIndex()`, so a tracked file a `.gitignore` pattern also matched
 * was dropped on a cold call and kept on a warm one.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { _resetTrackedFilesCacheForTests } from "../../clients/git-tracked-ignore.js";
import { readPathsArgument } from "../../tools/shared.js";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { execFileSync } from "../support/git-fixture-env.js";

async function names(cwd: string, raw: string[]): Promise<string[]> {
	const read = await readPathsArgument(raw, { cwd });
	expect(read.refusal).toBeUndefined();
	return read.entries
		.map((entry) => path.relative(cwd, entry).split(path.sep).join("/"))
		.sort();
}

describe("#5371 r2 the reader primes the tracked index before the walk", () => {
	// F5. Before: the walk never awaited `ensureTrackedIndex()`, so a tracked file
	// that a `.gitignore` pattern also matched was dropped on a cold call and kept
	// on a warm one — the answer depended on process warmth.
	it("returns the same set cold and warm: a tracked-but-ignored file is kept (F5)", async () => {
		const env = setupTestEnvironment("pi-lens-5371r2-tracked-", {
			rootMarker: false,
		});
		try {
			const cwd = env.tmpDir;
			execFileSync("git", ["init", "-q"], { cwd });
			execFileSync("git", ["config", "user.email", "t@t.t"], { cwd });
			execFileSync("git", ["config", "user.name", "t"], { cwd });
			for (const relative of ["src/a.ts", "src/tracked.ts"]) {
				fs.mkdirSync(path.dirname(path.join(cwd, relative)), {
					recursive: true,
				});
				fs.writeFileSync(path.join(cwd, relative), "export const value = 1;\n");
			}
			fs.writeFileSync(path.join(cwd, ".gitignore"), "src/tracked.ts\n");
			execFileSync("git", ["add", "-f", "src/tracked.ts", "src/a.ts"], { cwd });
			execFileSync("git", ["commit", "-q", "-m", "x"], { cwd });
			_resetTrackedFilesCacheForTests();
			const cold = await names(cwd, ["src/*.ts"]);
			const warm = await names(cwd, ["src/*.ts"]);
			expect(cold).toEqual(["src/a.ts", "src/tracked.ts"]);
			expect(warm).toEqual(cold);
		} finally {
			env.cleanup();
		}
	});
});
