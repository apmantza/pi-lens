import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	collectSourceFiles,
	filterSourceFiles,
	findSourceSibling,
	getFilterStats,
	isBuildArtifact,
	SOURCE_PRECEDENCE,
} from "../clients/source-filter.js";

/**
 * Helper to create a temporary directory structure for testing.
 */
function createTempDir(files: Record<string, string>): {
	dir: string;
	cleanup: () => void;
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "source-filter-test-"));

	for (const [filePath, content] of Object.entries(files)) {
		const fullPath = path.join(dir, filePath);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, content, "utf-8");
	}

	return {
		dir,
		cleanup: () => {
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe("findSourceSibling", () => {
	it("should find .ts sibling for .js file", () => {
		const { dir, cleanup } = createTempDir({
			"src/plan.ts": "// source",
			"src/plan.js": "// compiled",
		});

		const jsPath = path.join(dir, "src", "plan.js");
		const tsPath = path.join(dir, "src", "plan.ts");

		expect(findSourceSibling(jsPath)).toBe(tsPath);

		cleanup();
	});

	it("should find .tsx sibling for .jsx file", () => {
		const { dir, cleanup } = createTempDir({
			"component.tsx": "// tsx source",
			"component.jsx": "// compiled jsx",
		});

		const jsxPath = path.join(dir, "component.jsx");
		const tsxPath = path.join(dir, "component.tsx");

		expect(findSourceSibling(jsxPath)).toBe(tsxPath);

		cleanup();
	});

	it("should find .tsx sibling for .js file (fallback chain)", () => {
		const { dir, cleanup } = createTempDir({
			"app.tsx": "// source",
			"app.js": "// compiled",
		});

		const jsPath = path.join(dir, "app.js");
		const tsxPath = path.join(dir, "app.tsx");

		expect(findSourceSibling(jsPath)).toBe(tsxPath);

		cleanup();
	});

	it("should return null for .js file without sibling", () => {
		const { dir, cleanup } = createTempDir({
			"legacy.js": "// hand-written",
		});

		const jsPath = path.join(dir, "legacy.js");

		expect(findSourceSibling(jsPath)).toBeNull();

		cleanup();
	});

	it("should return null for .ts file (source, not artifact)", () => {
		const { dir, cleanup } = createTempDir({
			"source.ts": "// source",
		});

		const tsPath = path.join(dir, "source.ts");

		expect(findSourceSibling(tsPath)).toBeNull();

		cleanup();
	});

	it("should handle .vue files shadowing .js", () => {
		const { dir, cleanup } = createTempDir({
			"App.vue": "<!-- vue template -->",
			"App.js": "// compiled vue",
		});

		const jsPath = path.join(dir, "App.js");
		const vuePath = path.join(dir, "App.vue");

		expect(findSourceSibling(jsPath)).toBe(vuePath);

		cleanup();
	});

	it("should handle .svelte files shadowing .js", () => {
		const { dir, cleanup } = createTempDir({
			"Button.svelte": "<!-- svelte component -->",
			"Button.js": "// compiled svelte",
		});

		const jsPath = path.join(dir, "Button.js");
		const sveltePath = path.join(dir, "Button.svelte");

		expect(findSourceSibling(jsPath)).toBe(sveltePath);

		cleanup();
	});

	it("should handle .mjs and .cjs variants", () => {
		const { dir, cleanup } = createTempDir({
			"module.ts": "// source",
			"module.mjs": "// compiled mjs",
			"common.cts": "// source",
			"common.cjs": "// compiled cjs",
		});

		const mjsPath = path.join(dir, "module.mjs");
		const cjsPath = path.join(dir, "common.cjs");
		const tsPath = path.join(dir, "module.ts");
		const ctsPath = path.join(dir, "common.cts");

		expect(findSourceSibling(mjsPath)).toBe(tsPath);
		// .cts files aren't in precedence list, so .cjs won't be shadowed
		expect(findSourceSibling(cjsPath)).toBeNull();

		cleanup();
	});
});

describe("isBuildArtifact", () => {
	it("should return true for .js with .ts sibling", () => {
		const { dir, cleanup } = createTempDir({
			"plan.ts": "// source",
			"plan.js": "// compiled",
		});

		expect(isBuildArtifact(path.join(dir, "plan.js"))).toBe(true);

		cleanup();
	});

	it("should return false for standalone .js", () => {
		const { dir, cleanup } = createTempDir({
			"legacy.js": "// hand-written",
		});

		expect(isBuildArtifact(path.join(dir, "legacy.js"))).toBe(false);

		cleanup();
	});

	it("should return false for .ts source", () => {
		const { dir, cleanup } = createTempDir({
			"source.ts": "// source",
		});

		expect(isBuildArtifact(path.join(dir, "source.ts"))).toBe(false);

		cleanup();
	});
});

describe("filterSourceFiles", () => {
	it("should filter out .js files that have .ts siblings", () => {
		const { dir, cleanup } = createTempDir({
			"src/utils.ts": "// source",
			"src/utils.js": "// compiled",
			"src/helpers.ts": "// source",
			"src/helpers.js": "// compiled",
		});

		const input = [
			path.join(dir, "src", "utils.ts"),
			path.join(dir, "src", "utils.js"),
			path.join(dir, "src", "helpers.ts"),
			path.join(dir, "src", "helpers.js"),
		];

		const result = filterSourceFiles(input);

		// Should keep only .ts files
		expect(result).toHaveLength(2);
		expect(result).toContain(path.join(dir, "src", "utils.ts"));
		expect(result).toContain(path.join(dir, "src", "helpers.ts"));
		expect(result).not.toContain(path.join(dir, "src", "utils.js"));
		expect(result).not.toContain(path.join(dir, "src", "helpers.js"));

		cleanup();
	});

	it("should keep .js files without .ts siblings", () => {
		const { dir, cleanup } = createTempDir({
			"lib/legacy.js": "// hand-written",
			"lib/modern.ts": "// source",
			"lib/modern.js": "// compiled",
		});

		const input = [
			path.join(dir, "lib", "legacy.js"),
			path.join(dir, "lib", "modern.ts"),
			path.join(dir, "lib", "modern.js"),
		];

		const result = filterSourceFiles(input);

		// legacy.js has no sibling, modern.ts shadows modern.js
		expect(result).toHaveLength(2);
		expect(result).toContain(path.join(dir, "lib", "legacy.js"));
		expect(result).toContain(path.join(dir, "lib", "modern.ts"));

		cleanup();
	});

	it("should handle mixed file types", () => {
		const { dir, cleanup } = createTempDir({
			"main.ts": "// ts source",
			"main.js": "// compiled",
			"script.py": "# python",
			"helper.go": "// go",
			"lib.rs": "// rust",
		});

		const input = [
			path.join(dir, "main.ts"),
			path.join(dir, "main.js"),
			path.join(dir, "script.py"),
			path.join(dir, "helper.go"),
			path.join(dir, "lib.rs"),
		];

		const result = filterSourceFiles(input);

		// Python, Go, Rust have no artifact equivalents, always kept
		// main.ts shadows main.js
		expect(result).toHaveLength(4);
		expect(result).toContain(path.join(dir, "main.ts"));
		expect(result).toContain(path.join(dir, "script.py"));
		expect(result).toContain(path.join(dir, "helper.go"));
		expect(result).toContain(path.join(dir, "lib.rs"));
		expect(result).not.toContain(path.join(dir, "main.js"));

		cleanup();
	});

	it("should handle empty input", () => {
		expect(filterSourceFiles([])).toEqual([]);
	});

	it("should handle paths with spaces and special characters", () => {
		const { dir, cleanup } = createTempDir({
			"path with spaces/file.ts": "// source",
			"path with spaces/file.js": "// compiled",
			"unicode-文件/日本語.ts": "// source",
			"unicode-文件/日本語.js": "// compiled",
		});

		const input = [
			path.join(dir, "path with spaces", "file.ts"),
			path.join(dir, "path with spaces", "file.js"),
			path.join(dir, "unicode-文件", "日本語.ts"),
			path.join(dir, "unicode-文件", "日本語.js"),
		];

		const result = filterSourceFiles(input);

		expect(result).toHaveLength(2);
		expect(result).toContain(path.join(dir, "path with spaces", "file.ts"));
		expect(result).toContain(path.join(dir, "unicode-文件", "日本語.ts"));

		cleanup();
	});
});

describe("collectSourceFiles", () => {
	it("should collect files excluding build artifacts", () => {
		const { dir, cleanup } = createTempDir({
			"src/plan.ts": "// source",
			"src/plan.js": "// compiled",
			"src/utils/helper.ts": "// helper",
			"src/utils/helper.js": "// compiled",
			"legacy/lib.js": "// hand-written js",
		});

		const result = collectSourceFiles(dir);

		// Should find .ts files and hand-written .js, skip compiled .js
		expect(result).toContain(path.join(dir, "src", "plan.ts"));
		expect(result).toContain(path.join(dir, "src", "utils", "helper.ts"));
		expect(result).toContain(path.join(dir, "legacy", "lib.js"));
		expect(result).not.toContain(path.join(dir, "src", "plan.js"));
		expect(result).not.toContain(path.join(dir, "src", "utils", "helper.js"));

		cleanup();
	});

	it("should exclude node_modules and other standard dirs", () => {
		const { dir, cleanup } = createTempDir({
			"src/main.ts": "// source",
			"node_modules/lodash/index.js": "// library",
			"dist/bundle.js": "// bundle",
			".git/hooks/pre-commit": "#!/bin/sh",
		});

		const result = collectSourceFiles(dir);

		expect(result).toContain(path.join(dir, "src", "main.ts"));
		expect(result).not.toContain(
			path.join(dir, "node_modules", "lodash", "index.js"),
		);
		expect(result).not.toContain(path.join(dir, "dist", "bundle.js"));
		expect(result).not.toContain(path.join(dir, ".git", "hooks", "pre-commit"));

		cleanup();
	});

	it("should handle nested directories", () => {
		const { dir, cleanup } = createTempDir({
			"deep/nested/dir/file.ts": "// deep",
			"deep/nested/dir/file.js": "// compiled",
			"a/b/c/d/e/f/g.py": "# python",
		});

		const result = collectSourceFiles(dir);

		expect(result).toContain(
			path.join(dir, "deep", "nested", "dir", "file.ts"),
		);
		expect(result).toContain(
			path.join(dir, "a", "b", "c", "d", "e", "f", "g.py"),
		);
		expect(result).not.toContain(
			path.join(dir, "deep", "nested", "dir", "file.js"),
		);

		cleanup();
	});

	it("should handle custom extensions", () => {
		const { dir, cleanup } = createTempDir({
			"custom.xyz": "// xyz file",
			"normal.ts": "// ts file",
		});

		const result = collectSourceFiles(dir, { extensions: [".xyz"] });

		expect(result).toContain(path.join(dir, "custom.xyz"));
		expect(result).not.toContain(path.join(dir, "normal.ts"));

		cleanup();
	});

	it("should handle custom exclude directories", () => {
		const { dir, cleanup } = createTempDir({
			"src/main.ts": "// source",
			"custom-out/output.ts": "// output",
			"normal/file.ts": "// normal",
		});

		const result = collectSourceFiles(dir, { excludeDirs: ["custom-out"] });

		expect(result).toContain(path.join(dir, "src", "main.ts"));
		expect(result).toContain(path.join(dir, "normal", "file.ts"));
		expect(result).not.toContain(path.join(dir, "custom-out", "output.ts"));

		cleanup();
	});

	it("should return empty array for non-existent directory", () => {
		const result = collectSourceFiles("/non/existent/path");
		expect(result).toEqual([]);
	});

	it("should handle directories with no matching files", () => {
		const { dir, cleanup } = createTempDir({
			"readme.md": "# readme",
			"data.json": '{"key": "value"}',
		});

		const result = collectSourceFiles(dir);

		expect(result).toEqual([]);

		cleanup();
	});
});

describe("getFilterStats", () => {
	it("should calculate correct statistics", () => {
		const allFiles = [
			"a.ts",
			"a.js", // artifact
			"b.ts",
			"b.js", // artifact
			"c.js", // source
			"d.py",
		];
		const filtered = ["a.ts", "b.ts", "c.js", "d.py"];

		const stats = getFilterStats(allFiles, filtered);

		expect(stats.total).toBe(6);
		expect(stats.kept).toBe(4);
		expect(stats.skipped).toBe(2);
		expect(stats.byType[".js"]).toBe(2);
	});

	it("should handle no filtering", () => {
		const files = ["a.ts", "b.ts", "c.py"];

		const stats = getFilterStats(files, files);

		expect(stats.total).toBe(3);
		expect(stats.kept).toBe(3);
		expect(stats.skipped).toBe(0);
		expect(Object.keys(stats.byType)).toHaveLength(0);
	});

	it("should handle all files filtered", () => {
		const allFiles = ["a.js", "b.js", "c.jsx"];
		const filtered: string[] = [];

		const stats = getFilterStats(allFiles, filtered);

		expect(stats.total).toBe(3);
		expect(stats.kept).toBe(0);
		expect(stats.skipped).toBe(3);
	});
});

describe("SOURCE_PRECEDENCE completeness", () => {
	it("should have valid precedence chains", () => {
		for (const [sourceExt, shadowedExts] of Object.entries(SOURCE_PRECEDENCE)) {
			// Source extension should start with dot
			expect(sourceExt).toMatch(/^\./);

			// Shadowed extensions should all start with dot
			for (const shadowed of shadowedExts) {
				expect(shadowed).toMatch(/^\./);
			}

			// A source should not shadow itself
			expect(shadowedExts).not.toContain(sourceExt);
		}
	});
});
