import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	buildModuleGraph,
	clearModuleGraphCache,
	findModuleForPath,
	getDownstreamModules,
	getModuleSourceFiles,
} from "../../clients/review-graph/workspace-modules.js";
import { setupTestEnvironment } from "./test-utils.js";

// Counts readdirSync calls made through the module under test so memo-hit
// tests can prove no re-walk happened. Pure delegation — no behavior change.
const fsProbe = vi.hoisted(() => ({ counting: false, readdirSync: 0 }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readdirSync: (...args: unknown[]) => {
			if (fsProbe.counting) fsProbe.readdirSync += 1;
			return (actual.readdirSync as unknown as (...a: unknown[]) => unknown)(
				...args,
			);
		},
	};
});

function write(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

// Recurrence: AGENTS.md shape 83. `findModuleForPath` carried its own
// `key === root || key.startsWith(`${root}/`)` beside `isWithinForm`, the owner
// of that rule; a copy is where the directory boundary (`lib` is not `library`)
// and the deepest-owner choice drift apart.
describe("findModuleForPath asks the path owner's containment", () => {
	it("owns a file by the deepest module root at or above it, and by none for a text-prefix sibling", () => {
		const env = setupTestEnvironment("pi-lens-workspace-modules-owner-");
		try {
			write(
				path.join(env.tmpDir, "package.json"),
				JSON.stringify({ workspaces: ["packages/*", "packages/lib/inner"] }),
			);
			write(
				path.join(env.tmpDir, "packages/lib/package.json"),
				JSON.stringify({ name: "lib" }),
			);
			write(
				path.join(env.tmpDir, "packages/lib/inner/package.json"),
				JSON.stringify({ name: "inner" }),
			);
			const inLib = path.join(env.tmpDir, "packages/lib/src/a.ts");
			const inInner = path.join(env.tmpDir, "packages/lib/inner/src/b.ts");
			const sibling = path.join(env.tmpDir, "packages/library/src/c.ts");
			for (const file of [inLib, inInner, sibling]) write(file, "export {};\n");

			clearModuleGraphCache();
			const graph = buildModuleGraph(env.tmpDir)!;
			expect(findModuleForPath(graph, inLib)?.name).toBe("lib");
			expect(findModuleForPath(graph, inInner)?.name).toBe("inner");
			expect(
				findModuleForPath(graph, path.join(env.tmpDir, "packages/lib"))?.name,
			).toBe("lib");
			expect(findModuleForPath(graph, sibling)).toBeUndefined();
		} finally {
			clearModuleGraphCache();
			env.cleanup();
		}
	});
});

describe("workspace module graph", () => {
	it("expands pnpm workspace globs and computes downstream dependents", () => {
		const env = setupTestEnvironment("pi-lens-workspace-modules-pnpm-");
		try {
			write(
				path.join(env.tmpDir, "pnpm-workspace.yaml"),
				"packages:\n  - 'packages/*'\n",
			);
			write(
				path.join(env.tmpDir, "packages/core/package.json"),
				JSON.stringify({ name: "@demo/core" }),
			);
			write(
				path.join(env.tmpDir, "packages/app/package.json"),
				JSON.stringify({
					name: "@demo/app",
					dependencies: { "@demo/core": "workspace:*" },
				}),
			);
			write(
				path.join(env.tmpDir, "packages/app/src/index.ts"),
				"export const app = 1;\n",
			);

			clearModuleGraphCache();
			const graph = buildModuleGraph(env.tmpDir);
			expect(graph?.modules.has("@demo/core")).toBe(true);
			expect(graph?.modules.has("@demo/app")).toBe(true);
			expect(graph?.modules.get("@demo/app")?.internalDeps).toEqual([
				"@demo/core",
			]);
			expect(getDownstreamModules(graph!, "@demo/core")).toEqual(["@demo/app"]);
		} finally {
			clearModuleGraphCache();
			env.cleanup();
		}
	});

	it("finds owning module and recursively scans source files", () => {
		const env = setupTestEnvironment("pi-lens-workspace-modules-files-");
		try {
			write(
				path.join(env.tmpDir, "package.json"),
				JSON.stringify({ workspaces: ["packages/*"] }),
			);
			write(
				path.join(env.tmpDir, "packages/lib/package.json"),
				JSON.stringify({ name: "lib" }),
			);
			const source = path.join(env.tmpDir, "packages/lib/src/nested/util.ts");
			write(source, "export const util = 1;\n");
			write(
				path.join(env.tmpDir, "packages/lib/dist/generated.ts"),
				"export const generated = 1;\n",
			);

			clearModuleGraphCache();
			const graph = buildModuleGraph(env.tmpDir)!;
			expect(findModuleForPath(graph, source)?.name).toBe("lib");
			const files = getModuleSourceFiles(path.join(env.tmpDir, "packages/lib"));
			expect(files.some((file) => file.endsWith("/src/nested/util.ts"))).toBe(
				true,
			);
			expect(files.some((file) => file.includes("/dist/"))).toBe(false);
		} finally {
			clearModuleGraphCache();
			env.cleanup();
		}
	});
});

describe("getModuleSourceFiles memo (#1137)", () => {
	function makeWorkspace(env: { tmpDir: string }): string {
		write(
			path.join(env.tmpDir, "package.json"),
			JSON.stringify({ workspaces: ["packages/*"] }),
		);
		write(
			path.join(env.tmpDir, "packages/lib/package.json"),
			JSON.stringify({ name: "lib" }),
		);
		write(
			path.join(env.tmpDir, "packages/lib/src/index.ts"),
			"export const a = 1;\n",
		);
		return path.join(env.tmpDir, "packages/lib");
	}

	it("serves a repeat call from the memo without re-walking", () => {
		const env = setupTestEnvironment("pi-lens-module-src-memo-hit-");
		try {
			const libRoot = makeWorkspace(env);
			clearModuleGraphCache();
			const first = getModuleSourceFiles(libRoot);
			expect(first.length).toBeGreaterThan(0);
			const afterWalk = Date.now();
			vi.spyOn(Date, "now").mockReturnValue(afterWalk + 3_000);

			fsProbe.counting = true;
			fsProbe.readdirSync = 0;
			const second = getModuleSourceFiles(libRoot);
			fsProbe.counting = false;

			expect(second).toEqual(first);
			expect(fsProbe.readdirSync).toBe(0);
		} finally {
			vi.restoreAllMocks();
			fsProbe.counting = false;
			clearModuleGraphCache();
			env.cleanup();
		}
	});

	it("re-walks a same-tick write whose mtime aliases the stored stamp", () => {
		const env = setupTestEnvironment("pi-lens-module-src-memo-same-tick-");
		try {
			const libRoot = makeWorkspace(env);
			const srcDir = path.join(libRoot, "src");
			const coarseStamp = Math.floor(Date.now() / 2_000) * 2_000;
			fs.utimesSync(srcDir, coarseStamp / 1_000, coarseStamp / 1_000);
			clearModuleGraphCache();
			const first = getModuleSourceFiles(libRoot);
			const storedStamp = fs.statSync(srcDir).mtimeMs;
			const added = path.join(srcDir, "same-tick.ts");

			write(added, "export const sameTick = 1;\n");
			fs.utimesSync(added, storedStamp / 1_000, storedStamp / 1_000);
			fs.utimesSync(srcDir, storedStamp / 1_000, storedStamp / 1_000);
			expect(fs.statSync(srcDir).mtimeMs).toBe(storedStamp);
			expect(fs.statSync(added).mtimeMs).toBe(storedStamp);

			const second = getModuleSourceFiles(libRoot);
			expect(second.some((file) => file.endsWith("/src/same-tick.ts"))).toBe(
				true,
			);
			expect(second.length).toBe(first.length + 1);
		} finally {
			clearModuleGraphCache();
			env.cleanup();
		}
	});

	it("re-walks when a directory that fed the memo changes", () => {
		const env = setupTestEnvironment("pi-lens-module-src-memo-stale-");
		try {
			const libRoot = makeWorkspace(env);
			clearModuleGraphCache();
			const first = getModuleSourceFiles(libRoot);
			expect(first.some((f) => f.endsWith("/src/added.ts"))).toBe(false);

			const srcDir = path.join(libRoot, "src");
			write(path.join(srcDir, "added.ts"), "export const b = 2;\n");
			// Force a distinct dir mtime — same-tick writes can alias a coarse
			// mtime granularity and would make the invalidation vacuous (#1139
			// class: the regression test must actually reach the stale path).
			const future = new Date(Date.now() + 10_000);
			fs.utimesSync(srcDir, future, future);

			const second = getModuleSourceFiles(libRoot);
			expect(second.some((f) => f.endsWith("/src/added.ts"))).toBe(true);
			expect(second.length).toBe(first.length + 1);
		} finally {
			clearModuleGraphCache();
			env.cleanup();
		}
	});

	it("clearModuleGraphCache also clears the source-files memo", () => {
		const env = setupTestEnvironment("pi-lens-module-src-memo-clear-");
		try {
			const libRoot = makeWorkspace(env);
			clearModuleGraphCache();
			getModuleSourceFiles(libRoot);

			clearModuleGraphCache();
			fsProbe.counting = true;
			fsProbe.readdirSync = 0;
			getModuleSourceFiles(libRoot);
			fsProbe.counting = false;

			expect(fsProbe.readdirSync).toBeGreaterThan(0);
		} finally {
			fsProbe.counting = false;
			clearModuleGraphCache();
			env.cleanup();
		}
	});

	it("re-walks when an ignore-rule input changes (matcher identity)", () => {
		const env = setupTestEnvironment("pi-lens-module-src-memo-ignore-");
		try {
			// Pin resolveGitIgnoreRoot to the workspace so the .gitignore below is
			// the matcher's tracked input (existsSync(".git") is the only check).
			const libRoot = makeWorkspace(env);
			write(path.join(libRoot, "ignored/skip.ts"), "export const skip = 1;\n");
			clearModuleGraphCache();
			const first = getModuleSourceFiles(libRoot);
			expect(first.some((f) => f.includes("/ignored/"))).toBe(true);

			write(path.join(env.tmpDir, ".gitignore"), "ignored/\n");
			const second = getModuleSourceFiles(libRoot);
			expect(second.some((f) => f.includes("/ignored/"))).toBe(false);
		} finally {
			clearModuleGraphCache();
			env.cleanup();
		}
	});
});
