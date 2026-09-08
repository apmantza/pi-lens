import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetTrackedFilesCacheForTests,
	_resetUntrackedIgnoredCacheForTests,
	collectTrackedFiles,
	collectUntrackedIgnoredIds,
	parseUntrackedIgnoredOutput,
} from "../../clients/git-tracked-ignore.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import * as safeSpawn from "../../clients/safe-spawn.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";
import { gitExecFileSync } from "../support/git-fixture-env.js";
import {
	capThenAbortedSpawnResult,
	capThenTimedOutSpawnResult,
} from "../support/spawn-shapes.js";

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
		_resetTrackedFilesCacheForTests();
		resetDegradationLedger();
	});
	afterEach(() => {
		_resetUntrackedIgnoredCacheForTests();
		_resetTrackedFilesCacheForTests();
		vi.restoreAllMocks();
	});

	function initGitRepo(cwd: string): void {
		gitExecFileSync("git", ["init", "-q"], { cwd });
		gitExecFileSync("git", ["config", "user.email", "test@example.com"], {
			cwd,
		});
		gitExecFileSync("git", ["config", "user.name", "Test"], { cwd });
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
			gitExecFileSync("git", ["add", "src/vendor.js"], { cwd: env.tmpDir });
			gitExecFileSync("git", ["commit", "-q", "-m", "vendor"], {
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

	it.each([
		["untracked-ignored", collectUntrackedIgnoredIds],
		["tracked", collectTrackedFiles],
	] as const)(
		"fails closed when %s git ls-files output is truncated",
		async (site, collect) => {
			vi.spyOn(safeSpawn, "safeSpawnAsync").mockResolvedValue({
				stdout: "partial/path.ts\n",
				stderr: "",
				status: 1,
				outputTruncated: true,
			});

			expect(await collect(process.cwd())).toBeUndefined();
			expect(getDegradationSummary()).toEqual([
				{
					kind: "git-tracked-ignore-truncated",
					count: 1,
					droppedCount: 0,
					latestReasons: [
						{
							subject: `git-ls-files:${site}`,
							reason: "safeSpawnAsync capped git ls-files stdout",
						},
					],
				},
			]);
		},
	);

	it.each([
		{
			site: "untracked-ignored",
			collect: collectUntrackedIgnoredIds,
			resultFactory: capThenTimedOutSpawnResult,
		},
		{
			site: "tracked",
			collect: collectTrackedFiles,
			resultFactory: capThenTimedOutSpawnResult,
		},
		{
			site: "untracked-ignored",
			collect: collectUntrackedIgnoredIds,
			resultFactory: capThenAbortedSpawnResult,
		},
		{
			site: "tracked",
			collect: collectTrackedFiles,
			resultFactory: capThenAbortedSpawnResult,
		},
	])(
		"does not label a capped $site listing as truncated after timeout or abort",
		async ({ collect, resultFactory }) => {
			vi.spyOn(safeSpawn, "safeSpawnAsync").mockResolvedValue(
				resultFactory({ stdout: "partial/path.ts\n" }),
			);

			expect(await collect(process.cwd())).toBeUndefined();
			expect(getDegradationSummary()).toEqual([]);
		},
	);

	it.each([
		["untracked-ignored", collectUntrackedIgnoredIds],
		["tracked", collectTrackedFiles],
	] as const)("caps %s git ls-files stdout", async (_site, collect) => {
		const spawn = vi.spyOn(safeSpawn, "safeSpawnAsync").mockResolvedValue({
			stdout: "tracked/path.ts\n",
			stderr: "",
			status: 0,
		});

		await collect(process.cwd());

		expect(spawn).toHaveBeenCalledWith(
			"git",
			expect.any(Array),
			expect.objectContaining({ maxOutputBytes: 16 * 1024 * 1024 }),
		);
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
			gitExecFileSync("git", ["add", ".gitignore"], { cwd: env.tmpDir });
			gitExecFileSync("git", ["commit", "-q", "-m", "init"], {
				cwd: env.tmpDir,
			});

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
// flake-shape: real-process-spawn — real git children decide tracked-versus-ignored files from index state no stub reproduces
