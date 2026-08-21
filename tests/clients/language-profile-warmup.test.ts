/**
 * collectSourceFilesForWarmup (#250) — the warmup language-profile source walk.
 *
 * Guards the two failure modes behind a multi-hour home-dir scan: an UNCAPPED
 * walk, and the walk drifting outside its root. The runaway was triggered when
 * the warmup path ignored startup-scan's canWarmCaches=false and rooted this walk
 * at an ancestor ($HOME); the guard fix lives in runtime-session, and this caps
 * the walk as defense-in-depth + locks in root-confinement.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectSourceFilesForWarmup } from "../../clients/language-profile.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

// #1899: record every isIgnored() probe the walk makes (with its file/dir
// role) so a test can assert the walk NEVER consults the ignore matcher about
// a file it will drop by extension anyway. Delegates to the real matcher so
// ignore semantics stay intact.
const { ignoreCalls } = vi.hoisted(() => ({
	ignoreCalls: [] as { path: string; isDir: boolean }[],
}));

vi.mock("../../clients/file-utils.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/file-utils.js")>();
	return {
		...actual,
		getProjectIgnoreMatcher: (rootDir: string) => {
			const real = actual.getProjectIgnoreMatcher(rootDir);
			return {
				...real,
				isIgnored: (filePath: string, isDirectory = false): boolean => {
					ignoreCalls.push({ path: filePath, isDir: isDirectory });
					return real.isIgnored(filePath, isDirectory);
				},
			};
		},
	};
});

describe("collectSourceFilesForWarmup (#250)", () => {
	it("hard-caps the number of source files collected", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-cap-");
		try {
			for (let i = 0; i < 10; i++) {
				createTempFile(env.tmpDir, `f${i}.ts`, "export const x = 1;\n");
			}
			const files = await collectSourceFilesForWarmup(env.tmpDir, 3);
			expect(files).toHaveLength(3);
		} finally {
			env.cleanup();
		}
	});

	it("stays confined to the root — never walks a sibling/parent tree", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-root-");
		try {
			const root = path.join(env.tmpDir, "project");
			fs.mkdirSync(root, { recursive: true });
			createTempFile(root, "a.ts", "export const a = 1;\n");
			createTempFile(root, "sub/b.ts", "export const b = 1;\n");
			// A sibling OUTSIDE the root — the #250 escape would have swept this in.
			createTempFile(env.tmpDir, "outside/escape.ts", "export const z = 1;\n");

			const files = (await collectSourceFilesForWarmup(root)).map((f) =>
				f.replace(/\\/g, "/"),
			);

			expect(files.some((f) => f.endsWith("/project/a.ts"))).toBe(true);
			expect(files.some((f) => f.endsWith("/project/sub/b.ts"))).toBe(true);
			expect(files.some((f) => f.includes("/outside/"))).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("excludes node_modules / ignored directories", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-ignore-");
		try {
			createTempFile(env.tmpDir, "a.ts", "export const a = 1;\n");
			createTempFile(
				env.tmpDir,
				"node_modules/dep/index.ts",
				"export const d = 1;\n",
			);
			const files = (await collectSourceFilesForWarmup(env.tmpDir)).map((f) =>
				f.replace(/\\/g, "/"),
			);
			expect(files.some((f) => f.endsWith("/a.ts"))).toBe(true);
			expect(files.some((f) => f.includes("/node_modules/"))).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("does not let data/doc files ahead in walk order exhaust the code budget (#894 review)", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-priority-");
		try {
			// Root-level files are consumed before subdirectories in this walker,
			// so the json pile fills first — with a single shared budget of 3 the
			// walk would stop before ever reaching src/ and present.jsts would
			// flip false.
			for (let i = 0; i < 6; i++) {
				createTempFile(env.tmpDir, `locale${i}.json`, `{"n": ${i}}\n`);
			}
			createTempFile(env.tmpDir, "src/a.ts", "export const a = 1;\n");
			createTempFile(env.tmpDir, "src/b.ts", "export const b = 1;\n");

			const files = (await collectSourceFilesForWarmup(env.tmpDir, 3)).map(
				(f) => f.replace(/\\/g, "/"),
			);

			// Code kinds fill their own budget — both .ts files survive …
			expect(files.some((f) => f.endsWith("/src/a.ts"))).toBe(true);
			expect(files.some((f) => f.endsWith("/src/b.ts"))).toBe(true);
			// … while the non-code category stays capped at the same budget, so
			// json presence is still detected without unbounded collection.
			expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(3);
		} finally {
			env.cleanup();
		}
	});

	it("includes .dart files (#880)", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-dart-");
		try {
			createTempFile(env.tmpDir, "lib/main.dart", "void main() {}\n");
			const files = (await collectSourceFilesForWarmup(env.tmpDir)).map((f) =>
				f.replace(/\\/g, "/"),
			);
			expect(files.some((f) => f.endsWith("/lib/main.dart"))).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("checks the extension gate before consulting the ignore matcher (#1899)", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-extgate-");
		try {
			// A wal/-style runtime-output pile: many .log files, gitignored by the
			// FILE-level `*.log` pattern — so the directory itself is NOT pruned
			// and the walk descends into it (the yams shape that cost 30s).
			createTempFile(env.tmpDir, ".gitignore", "*.log\n");
			for (let i = 0; i < 30; i++) {
				createTempFile(env.tmpDir, `wal/wal_${i}.log`, "");
			}
			createTempFile(env.tmpDir, "src/a.ts", "export const a = 1;\n");

			ignoreCalls.length = 0;
			const files = (await collectSourceFilesForWarmup(env.tmpDir)).map((f) =>
				f.replace(/\\/g, "/"),
			);

			// Behavior preserved: the source file is collected, the .log pile is
			// excluded either way.
			expect(files.some((f) => f.endsWith("/src/a.ts"))).toBe(true);
			expect(files.some((f) => f.includes("/wal/"))).toBe(false);
			// The fix: the walk must never have asked the ignore matcher about a
			// non-source file — the cheap ext gate ran first and skipped it.
			const askedAboutLogs = ignoreCalls.filter(
				(c) => !c.isDir && c.path.endsWith(".log"),
			);
			expect(askedAboutLogs).toEqual([]);
		} finally {
			env.cleanup();
		}
	});
});
