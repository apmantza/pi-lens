/**
 * #775 — the startup source-count walk follows symlinks unconditionally
 * (`followSymlinks: true`, kept as-is so legitimate symlinked layouts like a
 * pnpm store don't change verdict), but had no cycle protection: two
 * directories symlinked into each other (or a directory symlinked into
 * itself) would otherwise re-walk the same subtree forever and hang
 * `session_start`.
 *
 * These tests pin that a symlink cycle completes (does not hang) with a sane
 * verdict, for both the sync and async walkers. `fs.symlinkSync(..., "junction")`
 * is used for directory symlinks on Windows since junctions work without
 * elevation; POSIX symlinks work unelevated already.
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

describe("startup-scan symlink-cycle guard (#775)", () => {
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
		// The guard only prevents an unbounded re-walk of the SAME symlink
		// target, so the directory the symlink points at is still legitimately
		// visited once more via the symlink before the cycle is caught on the
		// second recursion — the assertion here is boundedness (completes, small
		// finite count), not an exact count.
		expect(ctx.canWarmCaches).toBe(true);
		expect(ctx.sourceFileCount).toBeGreaterThan(0);
		expect(ctx.sourceFileCount).toBeLessThan(10);
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
		expect(ctx.sourceFileCount).toBeGreaterThan(0);
		expect(ctx.sourceFileCount).toBeLessThan(10);
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
		expect(ctx.sourceFileCount).toBeGreaterThan(0);
		expect(ctx.sourceFileCount).toBeLessThan(10);
	}, 10_000);
});
