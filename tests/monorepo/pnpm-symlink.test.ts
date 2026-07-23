/**
 * Track B (#775) item 8 — pnpm-shaped symlink layout.
 *
 * Extends the #777-era pinning (`tests/clients/startup-scan-symlink-cycle.test.ts`,
 * scoped to `startup-scan.ts`'s walker) to `source-filter.ts`'s walker
 * (`collectSourceFiles`/`collectSourceFilesAsync`), which every project-wide
 * scan (review graph, project-diagnostics, jscpd, word-index) ultimately
 * shares via `project-scan-policy.ts`.
 *
 * Layout: a `node_modules/.pnpm`-style content-addressed store (junction
 * symlinks standing in for pnpm's real symlink farm) PLUS one symlinked
 * directory OUTSIDE `node_modules` (a package aliasing a sibling via a
 * symlink, as some monorepo tools do). Expected/observed:
 *   - The walk completes (no hang from cycles inside the store).
 *   - `node_modules` (and therefore everything under `.pnpm`) is invisible
 *     regardless of symlink-following — it's excluded by NAME
 *     (`EXCLUDED_DIRS`, `file-utils.ts`), so `source-filter.ts`'s own
 *     `followSymlinks` option is irrelevant to that subtree; the directory is
 *     pruned before symlink-handling is ever consulted.
 *   - The symlinked directory OUTSIDE `node_modules` is NOT walked into by
 *     default (`followSymlinks` defaults to `false`, matching
 *     `DirWalkPolicy`'s documented default).
 *   - `followSymlinks: true` is, on Windows, OBSERVABLY INERT for a
 *     directory symlink created as a junction: `fs.Dirent.isDirectory()` is
 *     `false` for a junction (same classification `startup-scan-symlink-
 *     cycle.test.ts` already documents), so `classifyEntry`'s
 *     `entry.isDirectory()` branch — the only branch that ever calls
 *     `shouldRecurseIntoDir`/consults `followSymlinks` — never runs for it;
 *     the entry falls through to the `entry.isFile()` check (also false) and
 *     is silently skipped either way. Pinned here rather than asserting the
 *     "opt-in follows" behavior, since that behavior does not exist on
 *     Windows for this entry kind.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	collectSourceFiles,
	collectSourceFilesAsync,
} from "../../clients/source-filter.js";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { makeMonorepo, type MonorepoPackageSpec } from "./fixture.js";

function symlinkDir(target: string, linkPath: string): void {
	fs.symlinkSync(
		target,
		linkPath,
		process.platform === "win32" ? "junction" : "dir",
	);
}

function normalize(p: string): string {
	return p.replace(/\\/g, "/");
}

describe("pnpm-shaped symlink layout (#775 item 8, extends #777 to source-filter's walker)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	function buildFixture() {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: { "src/index.ts": "export const a = 1;\n" },
		};
		const repo = makeMonorepo({ packages: [pkg] });
		cleanups.push(repo.cleanup);

		// A pnpm-store-shaped content-addressed layout: node_modules/.pnpm/<hash>
		// holds the real files; node_modules/@scope/b is a junction pointing into
		// it (mirroring pnpm's symlink farm) — including a self-referential
		// junction to stress cycle-safety.
		const storeDir = path.join(
			repo.root,
			"packages/a/node_modules/.pnpm/@scope+b@1.0.0/node_modules/@scope/b",
		);
		fs.mkdirSync(storeDir, { recursive: true });
		fs.writeFileSync(path.join(storeDir, "index.ts"), "export const b = 1;\n");
		const linkDir = path.join(repo.root, "packages/a/node_modules/@scope");
		fs.mkdirSync(linkDir, { recursive: true });
		symlinkDir(storeDir, path.join(linkDir, "b"));
		// Self-referential junction inside the store — a plausible cycle shape.
		symlinkDir(storeDir, path.join(storeDir, "self-loop"));

		// A directory symlink OUTSIDE node_modules (e.g. a workspace-linked
		// package aliased via a plain symlink rather than an npm workspace).
		// The real target lives in a SEPARATE temp dir, entirely outside the
		// walked tree, so it can only ever be reached via the symlink below —
		// mirroring startup-scan-symlink-cycle.test.ts's "outside" fixture.
		const outside = setupTestEnvironment("pi-lens-pnpm-symlink-outside-");
		cleanups.push(outside.cleanup);
		fs.writeFileSync(
			path.join(outside.tmpDir, "hidden.ts"),
			"export const hidden = 1;\n",
		);
		symlinkDir(
			outside.tmpDir,
			path.join(repo.root, "packages/a/src/vendor-link"),
		);

		return repo;
	}

	it("sync collectSourceFiles completes (no hang), sees only the real source file, node_modules entirely invisible", () => {
		const repo = buildFixture();
		const files = collectSourceFiles(path.join(repo.root, "packages/a")).map(
			normalize,
		);
		expect(files.some((f) => f.endsWith("src/index.ts"))).toBe(true);
		expect(files.some((f) => f.includes("node_modules"))).toBe(false);
		expect(files.some((f) => f.endsWith("hidden.ts"))).toBe(false);
	}, 10_000);

	it("async collectSourceFilesAsync completes (no hang) with the same result set", async () => {
		const repo = buildFixture();
		const files = (
			await collectSourceFilesAsync(path.join(repo.root, "packages/a"))
		).map(normalize);
		expect(files.some((f) => f.endsWith("src/index.ts"))).toBe(true);
		expect(files.some((f) => f.includes("node_modules"))).toBe(false);
		expect(files.some((f) => f.endsWith("hidden.ts"))).toBe(false);
	}, 10_000);

	it("followSymlinks: true is inert for a Windows junction — the symlinked-outside-node_modules dir stays invisible either way", () => {
		if (process.platform !== "win32") {
			// eslint/vitest: document the platform boundary rather than silently
			// passing — a real POSIX symlink (not a junction) DOES report
			// isDirectory()===true, so followSymlinks:true would behave
			// differently there; that variant needs no elevation on POSIX and
			// would be worth its own assertion in a POSIX-only follow-up, not
			// asserted here to keep this file's behavior platform-uniform.
			return;
		}
		const repo = buildFixture();
		const files = collectSourceFiles(path.join(repo.root, "packages/a"), {
			followSymlinks: true,
		}).map(normalize);
		expect(files.some((f) => f.endsWith("hidden.ts"))).toBe(false);
	}, 10_000);
});
