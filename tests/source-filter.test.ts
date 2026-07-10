import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isGeneratedOrArtifact } from "../clients/generated-artifacts.js";
import { normalizeEphemeralMapKey } from "../clients/path-utils.js";
import {
	collectSourceFiles,
	collectSourceFilesAsync,
	createArtifactProbeCache,
	filterSourceFiles,
	findSourceSibling,
	getFilterStats,
	isBuildArtifact,
	SOURCE_PRECEDENCE,
} from "../clients/source-filter.js";

/**
 * Probe counter shared with the `node:fs` mock below. `existsSync` can't be
 * `vi.spyOn`'d directly in ESM (the module namespace object isn't
 * configurable), so instead the whole module is mocked, keeping every real
 * export except `existsSync`, which is wrapped to count calls before
 * delegating to the original implementation.
 */
let existsSyncProbeCount = 0;

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: (p: fs.PathLike) => {
			existsSyncProbeCount++;
			return actual.existsSync(p);
		},
	};
});

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

describe("isGeneratedOrArtifact", () => {
	it("detects generated/artifact paths and headers centrally", () => {
		expect(isGeneratedOrArtifact("src/generated/client.ts")).toBe(true);
		expect(isGeneratedOrArtifact("src/__generated__/types.ts")).toBe(true);
		expect(isGeneratedOrArtifact("src/api.pb.go")).toBe(true);
		expect(isGeneratedOrArtifact("src/index.d.ts")).toBe(false);
		expect(
			isGeneratedOrArtifact("src/index.d.ts", { includeDeclarations: true }),
		).toBe(true);
		expect(
			isGeneratedOrArtifact("src/client.ts", {
				content: "// Code generated by tool. DO NOT EDIT.\nexport {};\n",
			}),
		).toBe(true);
		expect(isGeneratedOrArtifact("src/handwritten.ts")).toBe(false);
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

	it("should filter generated artifact paths", () => {
		const { dir, cleanup } = createTempDir({
			"src/main.ts": "// source",
			"src/generated/client.ts": "// generated",
			"src/api.pb.go": "// generated protobuf",
		});

		const input = [
			path.join(dir, "src", "main.ts"),
			path.join(dir, "src", "generated", "client.ts"),
			path.join(dir, "src", "api.pb.go"),
		];

		const result = filterSourceFiles(input);

		expect(result).toEqual([path.join(dir, "src", "main.ts")]);

		cleanup();
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

	it("should exclude generated paths, declaration stubs, and generated headers", () => {
		const { dir, cleanup } = createTempDir({
			"src/main.ts": "// source",
			"src/generated/client.ts": "// codegen",
			"src/api.pb.go": "// protobuf",
			"src/types.d.ts": "export interface Types {}\n",
			"src/header.ts":
				"// This file was automatically generated.\nexport const x = 1;\n",
			"src/bundle.min.js": "const bundled = true;\n",
		});

		const result = collectSourceFiles(dir);

		expect(result).toContain(path.join(dir, "src", "main.ts"));
		expect(result).not.toContain(
			path.join(dir, "src", "generated", "client.ts"),
		);
		expect(result).not.toContain(path.join(dir, "src", "api.pb.go"));
		expect(result).not.toContain(path.join(dir, "src", "types.d.ts"));
		expect(result).not.toContain(path.join(dir, "src", "header.ts"));
		expect(result).not.toContain(path.join(dir, "src", "bundle.min.js"));

		cleanup();
	});

	it("can include generated files and declaration stubs when requested", () => {
		const { dir, cleanup } = createTempDir({
			"src/main.ts": "// source",
			"src/generated/client.ts": "// codegen",
			"src/types.d.ts": "export interface Types {}\n",
		});

		const result = collectSourceFiles(dir, {
			includeGenerated: true,
			includeDeclarationFiles: true,
		});

		expect(result).toContain(path.join(dir, "src", "main.ts"));
		expect(result).toContain(path.join(dir, "src", "generated", "client.ts"));
		expect(result).toContain(path.join(dir, "src", "types.d.ts"));

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

	it("should exclude glob-style directory patterns like *.dSYM", () => {
		const { dir, cleanup } = createTempDir({
			"src/main.ts": "// source",
			"MyApp.dSYM/Contents/Resources/symbol.ts": "// debug symbol payload",
		});

		const result = collectSourceFiles(dir);

		expect(result).toContain(path.join(dir, "src", "main.ts"));
		expect(result).not.toContain(
			path.join(dir, "MyApp.dSYM", "Contents", "Resources", "symbol.ts"),
		);

		cleanup();
	});

	it("should exclude directories case-insensitively", () => {
		const { dir, cleanup } = createTempDir({
			"src/main.ts": "// source",
			"NODE_MODULES/pkg/index.ts": "// should be excluded",
			"Coverage/report.ts": "// should be excluded",
		});

		const result = collectSourceFiles(dir);

		expect(result).toContain(path.join(dir, "src", "main.ts"));
		expect(result).not.toContain(
			path.join(dir, "NODE_MODULES", "pkg", "index.ts"),
		);
		expect(result).not.toContain(path.join(dir, "Coverage", "report.ts"));

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

// refs #191 item 1: per-walk sibling-probe memo. No persistent/module-global
// cache — the memo is created fresh per walk and discarded on return, so
// these tests build a fixture with several "tricky shapes" (an artifact next
// to its source twin, a lone .js with no sibling, a source file with an
// artifact-looking name, and nested dirs) and assert the memoized path never
// loses a detection relative to the unmemoized path.
describe("per-walk artifact probe memo (refs #191)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function buildTrickyFixture(): { dir: string; cleanup: () => void } {
		return createTempDir({
			// Real artifact next to its source twin.
			"src/plan.ts": "// source",
			"src/plan.js": "// compiled artifact",
			// Lone .js with no source sibling anywhere (hand-written).
			"src/standalone.js": "// hand-written, no sibling",
			// Source file whose *name* looks artifact-like (e.g. named like a
			// compiled bundle) but has no sibling shadowing it — must be kept.
			"src/legacy.min.ts": "// looks artifact-ish by name, is real source",
			// Several files in the same directory sharing the same probed
			// sibling name family, to exercise repeated probes.
			"src/utils/helper.ts": "// source",
			"src/utils/helper.js": "// compiled",
			"src/utils/helper.test.js": "// hand-written test, no .test.ts sibling",
			// Nested dirs, some with their own artifact pairs, some without.
			"src/nested/deep/widget.tsx": "// source",
			"src/nested/deep/widget.jsx": "// compiled",
			"src/nested/deep/orphan.jsx": "// no tsx sibling here",
			"src/nested/other/tool.coffee": "// source",
			"src/nested/other/tool.js": "// compiled coffee",
		});
	}

	it("classifies every file identically with and without the memo (no detection loss)", () => {
		const { dir, cleanup } = buildTrickyFixture();

		const allCandidates = [
			path.join(dir, "src", "plan.ts"),
			path.join(dir, "src", "plan.js"),
			path.join(dir, "src", "standalone.js"),
			path.join(dir, "src", "legacy.min.ts"),
			path.join(dir, "src", "utils", "helper.ts"),
			path.join(dir, "src", "utils", "helper.js"),
			path.join(dir, "src", "utils", "helper.test.js"),
			path.join(dir, "src", "nested", "deep", "widget.tsx"),
			path.join(dir, "src", "nested", "deep", "widget.jsx"),
			path.join(dir, "src", "nested", "deep", "orphan.jsx"),
			path.join(dir, "src", "nested", "other", "tool.coffee"),
			path.join(dir, "src", "nested", "other", "tool.js"),
		];

		// Query every candidate twice: once uncached (today's default
		// behavior), once sharing a single per-walk cache — as a directory
		// walk would. Results must match file-for-file.
		const uncached = allCandidates.map((f) => isBuildArtifact(f));

		const cache = createArtifactProbeCache();
		const cached = allCandidates.map((f) => isBuildArtifact(f, cache));

		expect(cached).toEqual(uncached);

		// Spot-check the expected verdicts explicitly so a bug that flips both
		// arrays identically still gets caught.
		const expected = [
			false, // plan.ts: source, not artifact
			true, // plan.js: shadowed by plan.ts
			false, // standalone.js: no sibling
			false, // legacy.min.ts: source (name looks artifact-ish, isn't one)
			false, // helper.ts: source
			true, // helper.js: shadowed by helper.ts
			false, // helper.test.js: no helper.test.ts sibling
			false, // widget.tsx: source
			true, // widget.jsx: shadowed by widget.tsx
			false, // orphan.jsx: no tsx sibling
			false, // tool.coffee: source
			true, // tool.js: shadowed by tool.coffee
		];
		expect(uncached).toEqual(expected);
		expect(cached).toEqual(expected);

		// Full-tree walk must also agree with the direct per-file classification
		// above, exercising the real classifyEntry -> collectSourceFiles path.
		const walked = collectSourceFiles(dir);
		const walkedSet = new Set(walked);
		for (let i = 0; i < allCandidates.length; i++) {
			// Non-source-shadow files still go through generated-artifact
			// filtering; only assert on the sibling-shadow verdict itself here
			// by checking artifacts are excluded and clean sources are present.
			if (expected[i]) {
				expect(walkedSet.has(allCandidates[i])).toBe(false);
			} else {
				expect(walkedSet.has(allCandidates[i])).toBe(true);
			}
		}

		cleanup();
	});

	it("collectSourceFiles and collectSourceFilesAsync agree with the sync, uncached path", async () => {
		const { dir, cleanup } = buildTrickyFixture();

		const sync = collectSourceFiles(dir).slice().sort();
		const async_ = (await collectSourceFilesAsync(dir)).slice().sort();

		expect(async_).toEqual(sync);

		cleanup();
	});

	it("performs strictly fewer existsSync probes with the memo for a directory of files sharing siblings", () => {
		const { dir, cleanup } = createTempDir({
			"src/shared.ts": "// the one shared source sibling",
			// N files that all probe for the SAME "shared.ts" sibling by virtue
			// of sharing the basename precedence chain indirectly is not how the
			// real check works (each file probes its own basename), so instead
			// generate N distinct artifact files each pointing at their own
			// pre-created sibling — this reproduces the real repeated-probe
			// pattern: a directory where many files each redundantly re-resolve
			// paths through the same directory, and repeated files with an
			// IDENTICAL basename+extension pair probed more than once.
		});

		// Build a directory where several files share the exact same
		// (dir, basename, candidate-extension) probe target by re-probing the
		// same path more than once — this models `filterSourceFiles` /
		// repeated lookups within one walk for the same file.
		const target = path.join(dir, "src", "shared.ts");
		expect(fs.existsSync(target)).toBe(true);

		const jsCandidate = path.join(dir, "src", "shared.js");

		// Simulate N repeated lookups for the identical candidate within one
		// walk (e.g. filterSourceFiles scanning a list that references the same
		// file more than once, or classifyEntry revisiting a path) — uncached.
		const N = 20;
		existsSyncProbeCount = 0;
		for (let i = 0; i < N; i++) {
			isBuildArtifact(jsCandidate);
		}
		const uncachedProbes = existsSyncProbeCount;

		existsSyncProbeCount = 0;
		const cache = createArtifactProbeCache();
		for (let i = 0; i < N; i++) {
			isBuildArtifact(jsCandidate, cache);
		}
		const cachedProbes = existsSyncProbeCount;

		expect(uncachedProbes).toBe(N);
		expect(cachedProbes).toBe(1);
		expect(cachedProbes).toBeLessThan(uncachedProbes);

		cleanup();
	});

	it("filterSourceFiles reduces probes vs. calling findSourceSibling per-file uncached, for a duplicated file list", () => {
		const { dir, cleanup } = createTempDir({
			"a.ts": "// source",
			"a.js": "// artifact",
			"b.ts": "// source",
			"b.js": "// artifact",
		});

		const files = [
			path.join(dir, "a.js"),
			path.join(dir, "a.js"), // duplicate reference, as a walker might pass
			path.join(dir, "b.js"),
			path.join(dir, "b.js"),
		];

		existsSyncProbeCount = 0;
		const result = filterSourceFiles(files);

		// Only 2 distinct probe targets (a.ts, b.ts) despite 4 input entries.
		expect(existsSyncProbeCount).toBe(2);
		expect(result).toEqual([]); // both are artifacts, both shadowed

		cleanup();
	});

	it("keys the probe cache through the real normalizeEphemeralMapKey (cross-form path equivalence)", () => {
		const { dir, cleanup } = buildTrickyFixture();

		const forwardSlashPath = path
			.join(dir, "src", "plan.js")
			.split(path.sep)
			.join("/");
		const backslashPath = path
			.join(dir, "src", "plan.js")
			.split("/")
			.join("\\");

		const cache = createArtifactProbeCache();

		// Prime the cache via one separator form.
		const firstResult = isBuildArtifact(forwardSlashPath, cache);

		// The other separator form must hit the same cache entry, i.e. resolve
		// to an identical verdict without a fresh probe needed — verified by
		// checking the cache is keyed on the normalized form both paths share.
		// This is the CHEAP, syntactic-only normalizer (no realpathSync) — the
		// cache exists specifically to avoid filesystem calls, so it must not
		// key through the expensive `normalizeMapKey` (see source-filter.ts's
		// probeExists doc for why that would defeat the memo, refs #191).
		expect(normalizeEphemeralMapKey(forwardSlashPath)).toBe(
			normalizeEphemeralMapKey(backslashPath),
		);

		const secondResult = isBuildArtifact(backslashPath, cache);
		expect(secondResult).toBe(firstResult);
		expect(secondResult).toBe(true);

		// Only one entry should exist in the underlying map for this sibling
		// path family (the source-precedence probe target), proving the two
		// separator forms collapsed onto the same key rather than being
		// treated as distinct paths.
		const tsSiblingKey = normalizeEphemeralMapKey(
			path.join(dir, "src", "plan.ts"),
		);
		expect(cache.has(tsSiblingKey)).toBe(true);

		cleanup();
	});
});
