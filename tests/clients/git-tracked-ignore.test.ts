import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetUntrackedIgnoredCacheForTests,
	collectUntrackedIgnoredIds,
	parseUntrackedIgnoredOutput,
} from "../../clients/git-tracked-ignore.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

describe("parseUntrackedIgnoredOutput", () => {
	it("parses repo-relative lines into normalized ids, skipping blanks", () => {
		const cwd = process.cwd();
		const ids = parseUntrackedIgnoredOutput(
			["clients/orphan.js", "", "scripts/tmp.mjs"].join("\n"),
			cwd,
		);
		expect(ids.size).toBe(2);
	});
});

describe("collectUntrackedIgnoredIds (#694)", () => {
	beforeEach(() => {
		_resetUntrackedIgnoredCacheForTests();
	});
	afterEach(() => {
		_resetUntrackedIgnoredCacheForTests();
	});

	function initGitRepo(cwd: string): void {
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
		execFileSync("git", ["config", "user.name", "Test"], { cwd });
	}

	it("returns the untracked-AND-ignored set, excluding tracked files that merely match the pattern", async () => {
		const env = setupTestEnvironment("pi-lens-git-tracked-ignore-");
		try {
			initGitRepo(env.tmpDir);
			const vendorPath = createTempFile(
				env.tmpDir,
				"src/vendor.js",
				"exports.vendor = 1;\n",
			);
			execFileSync("git", ["add", "src/vendor.js"], { cwd: env.tmpDir });
			execFileSync("git", ["commit", "-q", "-m", "vendor"], {
				cwd: env.tmpDir,
			});
			createTempFile(env.tmpDir, ".gitignore", "*.js\n");
			const genPath = createTempFile(
				env.tmpDir,
				"src/gen.js",
				"exports.gen = 1;\n",
			);

			const ids = await collectUntrackedIgnoredIds(env.tmpDir);
			expect(ids).toBeDefined();
			expect(ids?.has(normalizeMapKey(genPath))).toBe(true);
			expect(ids?.has(normalizeMapKey(vendorPath))).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("degrades to undefined (no throw) outside a git repo", async () => {
		const env = setupTestEnvironment("pi-lens-git-tracked-ignore-nogit-");
		try {
			const ids = await collectUntrackedIgnoredIds(env.tmpDir);
			expect(ids).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("memoizes within the TTL window: a file created after the first call is not yet reflected", async () => {
		const env = setupTestEnvironment("pi-lens-git-tracked-ignore-ttl-");
		try {
			initGitRepo(env.tmpDir);
			createTempFile(env.tmpDir, ".gitignore", "*.js\n");
			execFileSync("git", ["add", ".gitignore"], { cwd: env.tmpDir });
			execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: env.tmpDir });

			const first = await collectUntrackedIgnoredIds(env.tmpDir);
			expect(first?.size ?? 0).toBe(0);

			const laterPath = createTempFile(
				env.tmpDir,
				"src/later.js",
				"exports.later = 1;\n",
			);
			// Same process, within the TTL window: the cached (stale) result is
			// reused rather than re-spawning git — this is the whole point of the
			// memoization (a hot per-edit rebuild loop must not spawn per file).
			const second = await collectUntrackedIgnoredIds(env.tmpDir);
			expect(second).toBe(first);
			expect(second?.has(normalizeMapKey(laterPath))).toBe(false);

			// After an explicit reset (simulating TTL expiry), the fresh file is seen.
			_resetUntrackedIgnoredCacheForTests();
			const third = await collectUntrackedIgnoredIds(env.tmpDir);
			expect(third?.has(normalizeMapKey(laterPath))).toBe(true);
		} finally {
			env.cleanup();
		}
	});
});
