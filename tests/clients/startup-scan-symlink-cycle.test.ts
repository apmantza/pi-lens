/**
 * #775 audit follow-up — the startup source-count walk cannot be hung by a
 * symlink cycle, because symlinked directories are never traversed AT ALL:
 * `fs.Dirent` reports a symlink-to-directory as `isSymbolicLink() === true` /
 * `isDirectory() === false` (junctions included), so the visitor's directory
 * branch never sees them and they fall through to entry counting only. The
 * audit's suspected hang vector does not exist; these tests pin that
 * classification-derived behavior so a future walker refactor (e.g. one that
 * stat()s through symlinks) can't silently reintroduce the risk unbounded.
 *
 * `fs.symlinkSync(..., "junction")` is used for directory symlinks on Windows
 * since junctions work without elevation; POSIX symlinks work unelevated.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	resolveStartupScanContext,
	resolveStartupScanContextAsync,
} from "../../clients/startup-scan.js";
import { setupTestEnvironment } from "./test-utils.js";

function symlinkDir(target: string, linkPath: string): void {
	fs.symlinkSync(
		target,
		linkPath,
		process.platform === "win32" ? "junction" : "dir",
	);
}

describe("startup-scan symlink handling (#775)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	it("a directory symlinked into itself completes instead of hanging (sync)", () => {
		const env = setupTestEnvironment("pi-lens-symlink-self-");
		cleanups.push(env.cleanup);
		const homeEnv = setupTestEnvironment("pi-lens-symlink-self-home-");
		cleanups.push(homeEnv.cleanup);

		fs.mkdirSync(path.join(env.tmpDir, ".git"));
		fs.writeFileSync(path.join(env.tmpDir, "main.ts"), "export {};\n");
		symlinkDir(env.tmpDir, path.join(env.tmpDir, "self-loop"));

		const ctx = resolveStartupScanContext(env.tmpDir, {
			homeDir: homeEnv.tmpDir,
		});
		expect(ctx.canWarmCaches).toBe(true);
		// The symlinked dir is never walked into, so main.ts is counted exactly
		// once — not once per traversal of the loop.
		expect(ctx.sourceFileCount).toBe(1);
	}, 10_000);

	it("two directories symlinked into each other complete instead of hanging (sync)", () => {
		const env = setupTestEnvironment("pi-lens-symlink-mutual-");
		cleanups.push(env.cleanup);
		const homeEnv = setupTestEnvironment("pi-lens-symlink-mutual-home-");
		cleanups.push(homeEnv.cleanup);

		fs.mkdirSync(path.join(env.tmpDir, ".git"));
		const dirA = path.join(env.tmpDir, "a");
		const dirB = path.join(env.tmpDir, "b");
		fs.mkdirSync(dirA);
		fs.mkdirSync(dirB);
		fs.writeFileSync(path.join(dirA, "a.ts"), "export {};\n");
		fs.writeFileSync(path.join(dirB, "b.ts"), "export {};\n");
		symlinkDir(dirB, path.join(dirA, "link-to-b"));
		symlinkDir(dirA, path.join(dirB, "link-to-a"));

		const ctx = resolveStartupScanContext(env.tmpDir, {
			homeDir: homeEnv.tmpDir,
		});
		expect(ctx.canWarmCaches).toBe(true);
		// Each real file counted exactly once; the cross-links add zero.
		expect(ctx.sourceFileCount).toBe(2);
	}, 10_000);

	it("a symlinked-in subtree is NOT counted — symlinked dirs are never traversed", () => {
		const env = setupTestEnvironment("pi-lens-symlink-subtree-");
		cleanups.push(env.cleanup);
		const homeEnv = setupTestEnvironment("pi-lens-symlink-subtree-home-");
		cleanups.push(homeEnv.cleanup);
		const outside = setupTestEnvironment("pi-lens-symlink-outside-");
		cleanups.push(outside.cleanup);

		fs.mkdirSync(path.join(env.tmpDir, ".git"));
		fs.writeFileSync(path.join(env.tmpDir, "main.ts"), "export {};\n");
		// A real directory full of source files, reachable ONLY via a symlink.
		fs.writeFileSync(path.join(outside.tmpDir, "hidden1.ts"), "export {};\n");
		fs.writeFileSync(path.join(outside.tmpDir, "hidden2.ts"), "export {};\n");
		symlinkDir(outside.tmpDir, path.join(env.tmpDir, "linked"));

		const ctx = resolveStartupScanContext(env.tmpDir, {
			homeDir: homeEnv.tmpDir,
		});
		expect(ctx.canWarmCaches).toBe(true);
		// Only main.ts — the symlinked subtree's files are invisible to this
		// walk. If a refactor ever makes the walker follow symlinked dirs, this
		// starts failing (count 3), signalling that cycle protection is now
		// genuinely needed.
		expect(ctx.sourceFileCount).toBe(1);
	}, 10_000);

	it("a symlink cycle completes instead of hanging (async)", async () => {
		const env = setupTestEnvironment("pi-lens-symlink-async-");
		cleanups.push(env.cleanup);
		const homeEnv = setupTestEnvironment("pi-lens-symlink-async-home-");
		cleanups.push(homeEnv.cleanup);

		fs.mkdirSync(path.join(env.tmpDir, ".git"));
		fs.writeFileSync(path.join(env.tmpDir, "main.ts"), "export {};\n");
		symlinkDir(env.tmpDir, path.join(env.tmpDir, "self-loop"));

		const ctx = await resolveStartupScanContextAsync(env.tmpDir, {
			homeDir: homeEnv.tmpDir,
		});
		expect(ctx.canWarmCaches).toBe(true);
		expect(ctx.sourceFileCount).toBe(1);
	}, 10_000);
});
